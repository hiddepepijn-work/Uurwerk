/**
 * The same thinking turn as brain.ts, for OpenAI (Responses) and Anthropic (Messages),
 * so the benchmark can put each of them in Jarvis's place. Both stream, both cache the fixed
 * instruction: OpenAI on its own (a stable prefix over 1,024 tokens), Claude with explicit
 * cache_control marks on the tools and the instruction.
 */

import type { JarvisLiveUsage } from '@core/contract/api.js'
import { TOOLS } from '@core/services/jarvis-tools.js'

import { lastExchanges, sseEvents, type BrainTurn, type ThinkingBrain, type ToolRunner } from './brain.js'
import { condense } from './providers.js'

/** Per million tokens; `write` is what a cache write costs where it is billed apart. */
interface Price {
  input: number
  cached: number
  write?: number
  output: number
}

export const PRICES: Record<string, Price> = {
  'gpt-5.6-terra': { input: 2, cached: 0.2, output: 12 },
  'gpt-5.4-mini': { input: 0.75, cached: 0.075, output: 4.5 },
  'claude-sonnet-5': { input: 2, cached: 0.2, write: 2.5, output: 10 },
  'claude-haiku-4-5': { input: 1, cached: 0.1, write: 1.25, output: 5 }
}

const MAX_ROUNDS = 6

const blankUsage = (): JarvisLiveUsage => ({ provider: 'openai', textIn: 0, audioIn: 0, textOut: 0, audioOut: 0, thoughts: 0, textInCached: 0 })

async function failure(response: Response, who: string): Promise<Error> {
  const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } }
  return new Error(`${who} ${response.status}: ${body.error?.message ?? 'onbekende fout'}`)
}

// ---------------------------------------------------------------- OpenAI

/** An input or output item of the Responses API, passed back as it came. */
type ResponseItem = Record<string, unknown> & { type?: string }

/**
 * OpenAI through the Responses API: GPT-5.x refuses tools with reasoning on Chat Completions.
 * Stateless (store: false): the reasoning comes back encrypted and goes along with the tool
 * results, as the API requires within a tool loop.
 */
export class OpenAIBrain implements ThinkingBrain {
  private history: ResponseItem[] = []

  constructor(
    private readonly options: {
      key: string
      model: string
      fixed: string
      effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high'
      /** GPT-5's own knob for answer length: low is fewer words, and fewer to pay for. */
      verbosity?: 'low' | 'medium' | 'high'
    }
  ) {}

  async turn(userText: string, state: string, runTool: ToolRunner, onText?: (delta: string) => void): Promise<BrainTurn> {
    const started = Date.now()
    const usage = blankUsage()
    const turnItems: ResponseItem[] = [{ role: 'user', content: `<stand>\n${state}\n</stand>\n\n${userText}` }]
    let text = ''
    let firstTextMs: number | null = null

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.options.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.options.model,
          // The fixed instruction goes first: the prefix OpenAI caches.
          instructions: this.options.fixed,
          input: [...this.history, ...turnItems],
          tools: TOOLS.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters })),
          reasoning: { effort: this.options.effort ?? 'low' },
          ...(this.options.verbosity ? { text: { verbosity: this.options.verbosity } } : {}),
          store: false,
          include: ['reasoning.encrypted_content'],
          stream: true
        })
      })
      if (!response.ok || !response.body) throw await failure(response, 'OpenAI')

      let output: ResponseItem[] = []
      let content = ''
      for await (const event of sseEvents(response.body)) {
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
          if (firstTextMs === null) firstTextMs = Date.now() - started
          content += event.delta
          onText?.(event.delta)
        }
        if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') {
          const done = event.response as {
            output?: ResponseItem[]
            error?: { message?: string } | null
            usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } }
          }
          if (event.type === 'response.failed') throw new Error(`OpenAI: ${done.error?.message ?? 'antwoord mislukt'}`)
          output = done.output ?? []
          usage.textIn += done.usage?.input_tokens ?? 0
          usage.textInCached = (usage.textInCached ?? 0) + (done.usage?.input_tokens_details?.cached_tokens ?? 0)
          // Reasoning is part of output_tokens and billed as output.
          usage.textOut += done.usage?.output_tokens ?? 0
          usage.thoughts += done.usage?.output_tokens_details?.reasoning_tokens ?? 0
        }
      }
      text += content
      turnItems.push(...output)
      const calls = output.filter((item) => item.type === 'function_call') as Array<ResponseItem & { call_id: string; name: string; arguments: string }>
      if (calls.length === 0) break
      for (const call of calls) {
        let result: unknown
        try {
          result = { result: await runTool(call.name, JSON.parse(call.arguments || '{}') as Record<string, unknown>) }
        } catch (error) {
          result = { error: error instanceof Error ? error.message : String(error) }
        }
        turnItems.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) })
      }
      if (text && !/\s$/.test(text)) text += ' '
    }

    this.history.push({ role: 'user', content: userText }, ...turnItems.slice(1))
    // Tool results cut to a line once used, and only the last exchanges (see brain.ts).
    for (const item of this.history) if (item.type === 'function_call_output' && typeof item.output === 'string') item.output = condense(item.output)
    this.history = lastExchanges(this.history, (item) => item.role === 'user')
    return { text: text.trim(), firstTextMs, usage, usd: priced(this.options.model, usage) }
  }

  cutOff(heardText: string): void {
    for (let index = this.history.length - 1; index >= 0; index -= 1) {
      const item = this.history[index]!
      if (item.type !== 'message' || !Array.isArray(item.content)) continue
      const part = (item.content as Array<{ type?: string; text?: string }>).find((entry) => entry.type === 'output_text')
      if (part) {
        part.text = heardText
        return
      }
    }
  }

  async close(): Promise<void> {}
}


// ---------------------------------------------------------------- Claude

type ClaudeBlock =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
interface ClaudeMessage {
  role: 'user' | 'assistant'
  content: string | ClaudeBlock[]
}

export class ClaudeBrain implements ThinkingBrain {
  private history: ClaudeMessage[] = []
  /** Cache writes are billed apart from reads: kept to price them. */
  private written = 0

  constructor(
    private readonly options: {
      key: string
      model: string
      fixed: string
      /** Sonnet 5 thinks by default; "off" turns it off, "low" keeps it short. */
      thinking?: 'off' | 'low' | 'medium'
    }
  ) {}

  /** The history with a cache mark on its last block: everything before it is read from cache. */
  private cachedHistory(): ClaudeMessage[] {
    if (this.history.length === 0) return []
    const last = this.history[this.history.length - 1]!
    const blocks: ClaudeBlock[] = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : [...last.content]
    const tail = blocks[blocks.length - 1]!
    blocks[blocks.length - 1] = { ...tail, cache_control: { type: 'ephemeral' } } as ClaudeBlock
    return [...this.history.slice(0, -1), { role: last.role, content: blocks }]
  }

  private thinkingConfig(): Record<string, unknown> {
    const thinking = this.options.thinking ?? 'off'
    if (thinking === 'off') return { thinking: { type: 'disabled' } }
    return { thinking: { type: 'adaptive' }, output_config: { effort: thinking } }
  }

  async turn(userText: string, state: string, runTool: ToolRunner, onText?: (delta: string) => void): Promise<BrainTurn> {
    const started = Date.now()
    const usage = blankUsage()
    let writes = 0
    const turnMessages: ClaudeMessage[] = [{ role: 'user', content: `<stand>\n${state}\n</stand>\n\n${userText}` }]
    let text = ''
    let firstTextMs: number | null = null
    const tools = TOOLS.map((tool, index) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
      // The mark on the last tool caches all tools; the one on the system caches both.
      ...(index === TOOLS.length - 1 ? { cache_control: { type: 'ephemeral' } } : {})
    }))

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': this.options.key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.options.model,
          // Room for thinking and the answer: with 1024, Sonnet 5 thought until the limit and
          // said nothing (or cut a tool call off mid-argument).
          max_tokens: 4096,
          ...this.thinkingConfig(),
          system: [{ type: 'text', text: this.options.fixed, cache_control: { type: 'ephemeral' } }],
          tools,
          messages: [...this.cachedHistory(), ...turnMessages],
          stream: true
        })
      })
      if (!response.ok || !response.body) throw await failure(response, 'Claude')

      const blocks: Array<{ type: string; text?: string; id?: string; name?: string; json?: string; thinking?: string; signature?: string; data?: string }> = []
      for await (const event of sseEvents(response.body)) {
        switch (event.type) {
          case 'message_start': {
            const u = (event.message as { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }).usage ?? {}
            // input_tokens is only what was neither read from nor written to the cache.
            usage.textIn += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
            usage.textInCached = (usage.textInCached ?? 0) + (u.cache_read_input_tokens ?? 0)
            writes += u.cache_creation_input_tokens ?? 0
            break
          }
          case 'message_delta':
            usage.textOut += (event.usage as { output_tokens?: number } | undefined)?.output_tokens ?? 0
            break
          case 'content_block_start': {
            const block = event.content_block as { type: string; id?: string; name?: string; data?: string }
            blocks[event.index as number] = { type: block.type, id: block.id, name: block.name, text: '', json: '', thinking: '', signature: '', data: block.data }
            break
          }
          case 'content_block_delta': {
            const delta = event.delta as { type: string; text?: string; partial_json?: string; thinking?: string; signature?: string }
            const block = blocks[event.index as number]!
            // Thinking goes back as it came, signature and all: Claude checks it in a tool loop.
            if (delta.type === 'thinking_delta' && delta.thinking) block.thinking += delta.thinking
            if (delta.type === 'signature_delta' && delta.signature) block.signature += delta.signature
            if (delta.type === 'text_delta' && delta.text) {
              if (firstTextMs === null) firstTextMs = Date.now() - started
              block.text += delta.text
              onText?.(delta.text)
            }
            if (delta.type === 'input_json_delta' && delta.partial_json) block.json += delta.partial_json
            break
          }
        }
      }

      const content: ClaudeBlock[] = []
      for (const block of blocks.filter(Boolean)) {
        if (block.type === 'thinking') content.push({ type: 'thinking', thinking: block.thinking ?? '', signature: block.signature ?? '' })
        if (block.type === 'redacted_thinking' && block.data) content.push({ type: 'redacted_thinking', data: block.data })
        if (block.type === 'text' && block.text) content.push({ type: 'text', text: block.text })
        if (block.type === 'tool_use') content.push({ type: 'tool_use', id: block.id!, name: block.name!, input: JSON.parse(block.json || '{}') as Record<string, unknown> })
      }
      turnMessages.push({ role: 'assistant', content })
      text += content.filter((block) => block.type === 'text').map((block) => (block as { text: string }).text).join('')
      const uses = content.filter((block): block is Extract<ClaudeBlock, { type: 'tool_use' }> => block.type === 'tool_use')
      if (uses.length === 0) break
      const results: ClaudeBlock[] = []
      for (const use of uses) {
        try {
          results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(await runTool(use.name, use.input)) })
        } catch (error) {
          results.push({ type: 'tool_result', tool_use_id: use.id, content: error instanceof Error ? error.message : String(error), is_error: true })
        }
      }
      turnMessages.push({ role: 'user', content: results })
      if (text && !/\s$/.test(text)) text += ' '
    }

    this.history.push({ role: 'user', content: userText }, ...turnMessages.slice(1))
    for (const message of this.history) {
      if (typeof message.content === 'string') continue
      for (const block of message.content) if (block.type === 'tool_result') block.content = condense(block.content)
    }
    this.history = lastExchanges(this.history, (message) => message.role === 'user' && typeof message.content === 'string')
    this.written += writes
    return { text: text.trim(), firstTextMs, usage, usd: priced(this.options.model, usage, writes) }
  }

  cutOff(heardText: string): void {
    for (let index = this.history.length - 1; index >= 0; index -= 1) {
      const message = this.history[index]!
      if (message.role !== 'assistant' || typeof message.content === 'string') continue
      const block = message.content.find((entry) => entry.type === 'text') as { text: string } | undefined
      if (block) {
        block.text = heardText
        return
      }
    }
  }

  async close(): Promise<void> {}
}

/** Dollars for a turn: uncached input, cache reads, cache writes (Claude), output. */
function priced(model: string, usage: JarvisLiveUsage, writes = 0): number {
  const price = PRICES[model]
  if (!price) return 0
  const cached = Math.min(usage.textInCached ?? 0, usage.textIn)
  const plain = Math.max(0, usage.textIn - cached - writes)
  return (plain * price.input + cached * price.cached + writes * (price.write ?? price.input) + usage.textOut * price.output) / 1_000_000
}
