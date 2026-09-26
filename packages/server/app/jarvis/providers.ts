/**
 * The language model behind Jarvis, behind one small interface so the choice is a setting:
 * `JARVIS_MODEL=claude-opus-5` (default), `claude-sonnet-5`, `claude-haiku-4-5`, or an
 * OpenAI model such as `gpt-6-luna` or `gpt-5-mini`. Each provider keeps its own conversation history in
 * its own message format and runs the tool loop until the model has an answer.
 */

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'

import { TOOLS } from './tools.js'

export interface Turn {
  /** Jarvis's reply to read and speak. */
  text: string
  /** Whether a writing tool actually ran. */
  changed: boolean
}

export type RunTool = (name: string, input: Record<string, unknown>) => Promise<unknown>

export interface Conversation {
  /** One user message in, one reply out; history stays inside. */
  send(userText: string, context: string, runTool: RunTool): Promise<Turn>
}

export interface Provider {
  name: string
  model: string
  start(system: string): Conversation
}

/** Stop a runaway loop: a normal turn needs two or three tool rounds. */
const MAX_ROUNDS = 10

const WRITES = new Set(TOOLS.filter((tool) => tool.writes).map((tool) => tool.name))

async function callTool(runTool: RunTool, name: string, input: unknown): Promise<{ content: string; error: boolean; wrote: boolean }> {
  try {
    const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
    const result = await runTool(name, args)
    const refused = typeof result === 'object' && result !== null && 'refused' in result
    return { content: JSON.stringify(result), error: false, wrote: WRITES.has(name) && !refused }
  } catch (error) {
    return { content: error instanceof Error ? error.message : String(error), error: true, wrote: false }
  }
}

// --------------------------------------------------------------- Claude

export function claude(apiKey: string, model: string, effort: 'low' | 'medium' | 'high'): Provider {
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
        async send(userText, context, runTool) {
          // The standing instructions are cached; the moment-specific context rides with
          // the message, so it never invalidates that cache.
          history.push({ role: 'user', content: `${context}\n\n${userText}` })
          let changed = false

          for (let round = 0; round < MAX_ROUNDS; round++) {
            const response = await client.beta.messages.create({
              model,
              max_tokens: 4000,
              system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
              tools,
              messages: history,
              output_config: { effort },
              ...(fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {})
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
export function openai(apiKey: string, model: string, effort: 'low' | 'medium' | 'high'): Provider {
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
        async send(userText, context, runTool) {
          let changed = false
          let input: OpenAI.Responses.ResponseInput = [{ role: 'user', content: `${context}

${userText}` }]

          for (let round = 0; round < MAX_ROUNDS; round++) {
            const response = await client.responses.create({
              model,
              // Instructions are not carried over by previous_response_id; they go every time.
              instructions: system,
              input,
              tools,
              reasoning: { effort },
              previous_response_id: previous
            })
            previous = response.id

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
  effort: 'low' | 'medium' | 'high' | null
): Provider {
  const client = new OpenAI({ apiKey, baseURL })
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
        async send(userText, context, runTool) {
          history.push({ role: 'user', content: `${context}\n\n${userText}` })
          let changed = false

          for (let round = 0; round < MAX_ROUNDS; round++) {
            const response = await client.chat.completions.create({
              model,
              tools,
              messages: history,
              ...(effort ? { reasoning_effort: effort } : {})
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
