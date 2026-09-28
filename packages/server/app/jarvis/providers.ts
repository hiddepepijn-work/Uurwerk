/**
 * The language model behind Jarvis, behind one small interface so the choice is a setting:
 * `JARVIS_MODEL=claude-opus-5` (default), `claude-sonnet-5`, `claude-haiku-4-5`, or an
 * OpenAI model such as `gpt-6-luna` or `gpt-5-mini`. Each provider keeps its own conversation history in
 * its own message format and runs the tool loop until the model has an answer.
 */

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'

import { log } from '@backend/log.js'
import { TOOLS } from '@core/services/jarvis-tools.js'

export interface Turn {
  /** Jarvis's reply to read and speak. */
  text: string
  /** Whether a writing tool actually ran. */
  changed: boolean
}

export type RunTool = (name: string, input: Record<string, unknown>) => Promise<unknown>

export interface Conversation {
  /**
   * One user message in, one reply out; history stays inside. `kind` names the request in
   * the usage log (text, morning, evening); `effort` overrides the thinking level for this
   * turn — low for everyday questions, higher for replanning.
   */
  send(userText: string, context: string, runTool: RunTool, options?: TurnOptions): Promise<Turn>
}

export type Effort = 'low' | 'medium' | 'high'

export interface TurnOptions {
  kind?: string
  effort?: Effort
}

/** What one model request used: one log line per call, to see where the tokens go. */
export interface UsageEntry {
  model: string
  kind: string
  round: number
  prompt: number
  output: number
  thoughts: number
  cached: number
  toolCalls: number
  historyMessages: number
}

/** Who else wants each entry: the end-to-end test measures with it. */
export const usageListeners: Array<(entry: UsageEntry) => void> = []

export function logUsage(entry: UsageEntry): void {
  log.info('Jarvis usage.', entry)
  for (const listener of usageListeners) listener(entry)
}

export interface Provider {
  name: string
  model: string
  start(system: string): Conversation
}

/** Stop a runaway loop: a normal turn needs two or three tool rounds. */
const MAX_ROUNDS = 10

// ---------------------------------------------------------------- history
// Every request sends the whole history again, so what stays in it is paid for over and
// over. Three things keep it flat: the state of the day (the snapshot) rides only on the
// newest message, a tool result is cut to one line once the model has answered with it,
// and only the last TURNS exchanges go along at all. The database is the memory; the chat
// is not.

/**
 * Exchanges of history sent along, counted in Hidde's messages: a question that took four
 * tool rounds is still one exchange. (Counting raw messages let one busy answer push
 * everything he said before out of the window, and Jarvis forgot it.)
 */
export const TURNS = 8

const STATE_OPEN = '[stand]'
const STATE_CLOSE = '[/stand]'

/** The newest user message: the state of the day first, then what Hidde said. */
export const withState = (context: string, userText: string): string =>
  `${STATE_OPEN}\n${context}\n${STATE_CLOSE}\n\n${userText}`

/** An older user message: only what Hidde said. The state it carried is out of date anyway. */
export const withoutState = (text: string): string => {
  const end = text.indexOf(STATE_CLOSE)
  return text.startsWith(STATE_OPEN) && end >= 0 ? text.slice(end + STATE_CLOSE.length).trimStart() : text
}

/** A tool result the model has already used: what it was, in one line. */
export function condense(content: string): string {
  if (content.length <= 240) return content
  try {
    const value = JSON.parse(content) as unknown
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>
      if (Array.isArray(record.executed) || Array.isArray(record.failed)) {
        const done = (record.executed as Array<{ summary: string }> | undefined)?.map((entry) => entry.summary) ?? []
        const failed =
          (record.failed as Array<{ summary: string; error: string }> | undefined)?.map(
            (entry) => `${entry.summary}: ${entry.error}`
          ) ?? []
        return JSON.stringify({ uitgevoerd: done, mislukt: failed })
      }
    }
  } catch {
    // Not JSON: plain text, cut below.
  }
  return `[al gebruikt, ${content.length} tekens] ${content.slice(0, 160)}…`
}

/**
 * Where the window starts: at the TURNS-th most recent plain user message (not a tool
 * result), so a window never begins in the middle of a tool exchange, which the APIs refuse.
 * `first` skips what always stays, like the system message.
 */
export function windowStart<T>(messages: T[], first: number, isPlainUser: (message: T) => boolean): number {
  let start = -1
  let questions = 0
  for (let index = messages.length - 1; index >= first; index--) {
    if (!isPlainUser(messages[index]!)) continue
    start = index
    questions += 1
    if (questions === TURNS) break
  }
  return start === -1 ? first : start
}

const WRITES = new Set(TOOLS.filter((tool) => tool.writes).map((tool) => tool.name))

async function callTool(runTool: RunTool, name: string, input: unknown): Promise<{ content: string; error: boolean; wrote: boolean }> {
  try {
    const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
    const result = await runTool(name, args)
    // A proposal, a refusal or an error changed nothing; only confirm and the timer write.
    const nothing =
      typeof result === 'object' && result !== null && ('pendingId' in result || 'error' in result || 'refused' in result)
    return { content: JSON.stringify(result), error: false, wrote: WRITES.has(name) && !nothing }
  } catch (error) {
    return { content: error instanceof Error ? error.message : String(error), error: true, wrote: false }
  }
}

// --------------------------------------------------------------- Claude

export function claude(apiKey: string, model: string, effort: Effort): Provider {
  const client = new Anthropic({ apiKey })
  const tools: Anthropic.Beta.BetaTool[] = TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as Anthropic.Beta.BetaTool.InputSchema
  }))
  // Opus 5 and up can decline a request; the server then re-runs it on a fallback model
  // within the same call instead of leaving Jarvis without an answer.
  const fallbacks = /^claude-(opus-5|fable)/.test(model)

  return {
    name: 'anthropic',
    model,
    start(system) {
      const history: Anthropic.Beta.BetaMessageParam[] = []

      return {
        async send(userText, context, runTool, { kind = 'text', effort: turnEffort }: TurnOptions = {}) {
          // The standing instructions are cached; the moment-specific context rides with
          // the newest message only, so it never invalidates that cache.
          for (const message of history) {
            if (message.role !== 'user') continue
            if (typeof message.content === 'string') message.content = withoutState(message.content)
            else
              for (const block of message.content)
                if (block.type === 'tool_result' && typeof block.content === 'string') block.content = condense(block.content)
          }
          history.push({ role: 'user', content: withState(context, userText) })
          history.splice(0, windowStart(history, 0, (message) => message.role === 'user' && typeof message.content === 'string'))
          let changed = false

          for (let round = 0; round < MAX_ROUNDS; round++) {
            const response = await client.beta.messages.create({
              model,
              max_tokens: 4000,
              system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
              tools,
              messages: history,
              output_config: { effort: turnEffort ?? effort },
              ...(fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {})
            })
            logUsage({
              model: response.model ?? model,
              kind,
              round,
              prompt: response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0),
              output: response.usage.output_tokens,
              thoughts: 0,
              cached: response.usage.cache_read_input_tokens ?? 0,
              toolCalls: response.content.filter((block) => block.type === 'tool_use').length,
              historyMessages: history.length
            })

            if (response.stop_reason === 'refusal') {
              history.pop()
              return { text: 'Daar kan ik je niet mee helpen. Zeg het anders?', changed }
            }

            history.push({ role: 'assistant', content: response.content })

            const calls = response.content.filter(
              (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === 'tool_use'
            )
            if (response.stop_reason !== 'tool_use' || calls.length === 0) {
              const text = response.content
                .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
                .map((block) => block.text)
                .join('\n')
                .trim()
              return { text: text || 'Oké.', changed }
            }

            const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
            for (const call of calls) {
              const outcome = await callTool(runTool, call.name, call.input)
              changed ||= outcome.wrote
              results.push({ type: 'tool_result', tool_use_id: call.id, content: outcome.content, is_error: outcome.error })
            }
            // All results of one round in one message, as the API expects.
            history.push({ role: 'user', content: results })
          }
          return { text: 'Ik kom er niet uit binnen een redelijk aantal stappen. Zeg het korter?', changed }
        }
      }
    }
  }
}

// --------------------------------------------------------------- OpenAI

/**
 * OpenAI through the Responses API: the model thinks (reasoning effort, medium by default)
 * and calls tools in the same turn — Chat Completions only allows tools with reasoning off
 * on the GPT-6 family. The conversation is chained with previous_response_id, so OpenAI
 * keeps the model's own reasoning between turns and nothing has to be sent back by hand.
 */
export function openai(apiKey: string, model: string, effort: Effort): Provider {
  const client = new OpenAI({ apiKey })
  const tools: OpenAI.Responses.FunctionTool[] = TOOLS.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false
  }))

  return {
    name: 'openai',
    model,
    start(system) {
      let previous: string | null = null

      return {
        async send(userText, context, runTool, { kind = 'text', effort: turnEffort }: TurnOptions = {}) {
          let changed = false
          let input: OpenAI.Responses.ResponseInput = [{ role: 'user', content: withState(context, userText) }]

          for (let round = 0; round < MAX_ROUNDS; round++) {
            const response = await client.responses.create({
              model,
              // Instructions are not carried over by previous_response_id; they go every time.
              instructions: system,
              input,
              tools,
              reasoning: { effort: turnEffort ?? effort },
              previous_response_id: previous
            })
            previous = response.id
            logUsage({
              model: response.model ?? model,
              kind,
              round,
              prompt: response.usage?.input_tokens ?? 0,
              output: response.usage?.output_tokens ?? 0,
              thoughts: response.usage?.output_tokens_details?.reasoning_tokens ?? 0,
              cached: response.usage?.input_tokens_details?.cached_tokens ?? 0,
              toolCalls: response.output.filter((item) => item.type === 'function_call').length,
              historyMessages: round + 1
            })

            const calls = response.output.filter(
              (item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === 'function_call'
            )
            if (calls.length === 0) return { text: response.output_text.trim() || 'Oké.', changed }

            const outputs: OpenAI.Responses.ResponseInput = []
            for (const call of calls) {
              let args: unknown = {}
              try {
                args = JSON.parse(call.arguments || '{}')
              } catch {
                outputs.push({ type: 'function_call_output', call_id: call.call_id, output: 'Ongeldige JSON in de argumenten.' })
                continue
              }
              const outcome = await callTool(runTool, call.name, args)
              changed ||= outcome.wrote
              outputs.push({ type: 'function_call_output', call_id: call.call_id, output: outcome.content })
            }
            input = outputs
          }
          return { text: 'Ik kom er niet uit binnen een redelijk aantal stappen. Zeg het korter?', changed }
        }
      }
    }
  }
}

// ------------------------------------------------- OpenAI-compatible (Gemini, Mistral)

/**
 * Providers that speak OpenAI's Chat Completions on their own endpoint: Google Gemini and
 * Mistral. Both have a free tier that needs no payment card, which is why they are here.
 * Thinking goes through `reasoning_effort` where the provider supports it (Gemini).
 */
export function compatible(
  name: string,
  baseURL: string,
  apiKey: string,
  model: string,
  effort: Effort | null,
  /** Tried in order when the model is overloaded (503) or out of quota (429). */
  fallbackModels: string[] = []
): Provider {
  // No retries inside the SDK: on a 429 it would first sit out the retry-after (up to a
  // minute) on a model whose quota is gone. The next model in the chain answers right away.
  const client = new OpenAI({ apiKey, baseURL, maxRetries: 0, timeout: 60_000 })
  const chain = [model, ...fallbackModels.filter((entry) => entry && entry !== model)]
  /** Models out of quota, and until when to leave them alone. */
  const resting = new Map<string, number>()

  /** One completion, moving down the chain while models are busy or out of quota. */
  const complete = async (
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    tools: OpenAI.Chat.Completions.ChatCompletionFunctionTool[],
    turnEffort: Effort | undefined
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> => {
    let lastError: unknown = null
    const awake = chain.filter((candidate) => (resting.get(candidate) ?? 0) < Date.now())
    for (const candidate of awake.length > 0 ? awake : chain) {
      try {
        return await client.chat.completions.create({
          model: candidate,
          tools,
          messages,
          ...(effort ? { reasoning_effort: turnEffort ?? effort } : {})
        })
      } catch (error) {
        if (error instanceof OpenAI.APIError && (error.status === 503 || error.status === 429)) {
          // Out of free quota: skip it for a while. Busy (503): only this once.
          if (error.status === 429) resting.set(candidate, Date.now() + 15 * 60_000)
          lastError = error
          continue
        }
        throw error
      }
    }
    throw lastError
  }
  const tools: OpenAI.Chat.Completions.ChatCompletionFunctionTool[] = TOOLS.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters }
  }))

  return {
    name,
    model,
    start(system) {
      const history: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [{ role: 'system', content: system }]

      return {
        async send(userText, context, runTool, { kind = 'text', effort: turnEffort }: TurnOptions = {}) {
          for (const message of history) {
            if (message.role === 'user' && typeof message.content === 'string') message.content = withoutState(message.content)
            if (message.role === 'tool' && typeof message.content === 'string') message.content = condense(message.content)
          }
          history.push({ role: 'user', content: withState(context, userText) })
          // The system message stays; the rest is the window.
          history.splice(1, windowStart(history, 1, (message) => message.role === 'user') - 1)
          let changed = false

          for (let round = 0; round < MAX_ROUNDS; round++) {
            const response = await complete(history, tools, turnEffort)
            logUsage({
              model: response.model ?? model,
              kind,
              round,
              prompt: response.usage?.prompt_tokens ?? 0,
              output: response.usage?.completion_tokens ?? 0,
              thoughts: response.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
              cached: response.usage?.prompt_tokens_details?.cached_tokens ?? 0,
              toolCalls: response.choices[0]?.message?.tool_calls?.length ?? 0,
              historyMessages: history.length
            })
            const message = response.choices[0]?.message
            if (!message) return { text: 'Geen antwoord gekregen.', changed }
            history.push(message)

            const calls = (message.tool_calls ?? []).filter((call) => call.type === 'function')
            if (calls.length === 0) return { text: message.content?.trim() || 'Oké.', changed }

            for (const call of calls) {
              let args: unknown = {}
              try {
                args = JSON.parse(call.function.arguments || '{}')
              } catch {
                history.push({ role: 'tool', tool_call_id: call.id, content: 'Ongeldige JSON in de argumenten.' })
                continue
              }
              const outcome = await callTool(runTool, call.function.name, args)
              changed ||= outcome.wrote
              history.push({ role: 'tool', tool_call_id: call.id, content: outcome.content })
            }
          }
          return { text: 'Ik kom er niet uit binnen een redelijk aantal stappen. Zeg het korter?', changed }
        }
      }
    }
  }
}
