/**
 * The thinking part of a cascade: Gemini Flash over its native streaming API, with the fixed
 * instruction and the tools in an explicit context cache.
 *
 * Why explicit: Gemini Live cannot cache, and Flash does not cache implicitly either (measured
 * on 28 Sep 2026: 0 of 4,600 tokens on five identical requests). An explicit cache did take
 * 4,617 of 4,623. The fixed part (~6k tokens: rules, brief, tools) is read at a tenth of the
 * price; only the state of today, the history and Hidde's words are paid in full.
 *
 * The cache lives as long as the conversation (TTL renewed while it is used) and is deleted
 * at the end, so storage costs next to nothing.
 */

import type { JarvisLiveUsage } from '@core/contract/api.js'
import { TOOLS } from '@core/services/jarvis-tools.js'

import { toSchema } from './live.js'
import { condense } from './providers.js'

const BASE = 'https://generativelanguage.googleapis.com/v1beta'
/** How long an unused cache stays; renewed on every turn. */
const CACHE_TTL_S = 600
/** A normal turn needs one or two tool rounds; stop a runaway loop. */
const MAX_ROUNDS = 6

/** Gemini 3.8 Flash per million tokens, introductory prices until the end of 2026. */
export const FLASH_PRICE = { input: 0.75, cached: 0.075, output: 3.75, storagePerHour: 0.5 } as const

interface Part {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> }
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> }
}
interface Content {
  role: 'user' | 'model'
  parts: Part[]
}
interface UsageMetadata {
  promptTokenCount?: number
  cachedContentTokenCount?: number
  candidatesTokenCount?: number
  thoughtsTokenCount?: number
}

/**
 * Reads a server-sent-events body: one parsed JSON object per event. Line endings may be
 * \r\n, and the last event may come without the blank line after it.
 */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''
  const parse = (event: string): Record<string, unknown> | null => {
    const data = event
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('')
    return data && data !== '[DONE]' ? (JSON.parse(data) as Record<string, unknown>) : null
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '')
    let end: number
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const event = parse(buffer.slice(0, end))
      buffer = buffer.slice(end + 2)
      if (event) yield event
    }
  }
  const last = parse(buffer.trim())
  if (last) yield last
}

export interface BrainOptions {
  key: string
  model?: string
  thinking?: 'low' | 'medium' | 'high'
  /** The instruction that stays the same (rules, brief); goes into the cache. */
  fixed: string
}

export interface BrainTurn {
  text: string
  /** Milliseconds from the request to the first words he says (any round). */
  firstTextMs: number | null
  usage: JarvisLiveUsage
  /** What the turn cost, cache included. */
  usd: number
}

/** A model that thinks for Jarvis: the same turn for Gemini, OpenAI and Claude. */
export interface ThinkingBrain {
  turn(userText: string, state: string, runTool: ToolRunner, onText?: (delta: string) => void): Promise<BrainTurn>
  cutOff(heardText: string): void
  close(): Promise<void>
}

export type ToolRunner = (name: string, args: Record<string, unknown>) => Promise<unknown>

export class Brain implements ThinkingBrain {
  private readonly model: string
  private readonly thinking: string
  private cache: { name: string; until: number } | null = null
  private history: Content[] = []
  /** The cache made by warm(), billed with the first turn. */
  private warmUsd = 0

  constructor(private readonly options: BrainOptions) {
    this.model = options.model ?? 'gemini-3.8-flash'
    this.thinking = options.thinking ?? 'low'
  }

  private async call(path: string, body?: unknown, method = 'POST'): Promise<Record<string, unknown>> {
    const response = await fetch(`${BASE}/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.options.key },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown> & { error?: { message?: string } }
    if (!response.ok) throw new Error(`Gemini ${response.status}: ${json.error?.message ?? 'onbekende fout'}`)
    return json
  }

  /** The cache of instruction + tools: made on the first turn, kept alive while talking. */
  private async ensureCache(): Promise<number> {
    const now = Date.now()
    if (this.cache && this.cache.until - now > 60_000) return 0
    if (this.cache) {
      await this.call(this.cache.name, { ttl: `${CACHE_TTL_S}s` }, 'PATCH').catch(() => (this.cache = null))
      if (this.cache) {
        this.cache.until = now + CACHE_TTL_S * 1000
        return 0
      }
    }
    const created = (await this.call('cachedContents', {
      model: `models/${this.model}`,
      systemInstruction: { parts: [{ text: this.options.fixed }] },
      tools: [{ functionDeclarations: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, parameters: toSchema(tool.parameters) })) }],
      ttl: `${CACHE_TTL_S}s`
    })) as { name?: string; usageMetadata?: { totalTokenCount?: number } }
    if (!created.name) throw new Error('Gemini maakte geen cache.')
    this.cache = { name: created.name, until: now + CACHE_TTL_S * 1000 }
    // Creating it reads the tokens once at the normal price; keeping it ten minutes is extra.
    const tokens = created.usageMetadata?.totalTokenCount ?? 0
    return (tokens * FLASH_PRICE.input + tokens * FLASH_PRICE.storagePerHour * (CACHE_TTL_S / 3600)) / 1_000_000
  }

  /** One generation, streamed: the parts in order, and when the first words came. */
  private async generate(contents: Content[], started: number, onText?: (delta: string) => void): Promise<{ parts: Part[]; usage: UsageMetadata; firstTextMs: number | null }> {
    const response = await fetch(`${BASE}/models/${this.model}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.options.key },
      body: JSON.stringify({
        cachedContent: this.cache!.name,
        contents,
        generationConfig: { thinkingConfig: { thinkingLevel: this.thinking } }
      })
    })
    if (!response.ok || !response.body) {
      const error = (await response.json().catch(() => ({}))) as { error?: { message?: string } }
      throw new Error(`Gemini ${response.status}: ${error.error?.message ?? 'onbekende fout'}`)
    }
    const parts: Part[] = []
    let usage: UsageMetadata = {}
    let firstTextMs: number | null = null
    {
      for await (const raw of sseEvents(response.body)) {
        const chunk = raw as { candidates?: Array<{ content?: { parts?: Part[] } }>; usageMetadata?: UsageMetadata }
        if (chunk.usageMetadata) usage = chunk.usageMetadata
        for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
          const last = parts[parts.length - 1]
          // Streamed text arrives in pieces: one part, with its signature if any piece had one.
          if (part.text !== undefined && !part.thought && last && last.text !== undefined && !last.thought && !last.functionCall) {
            last.text += part.text
            if (part.thoughtSignature) last.thoughtSignature = part.thoughtSignature
          } else {
            parts.push({ ...part })
          }
          if (part.text && !part.thought) {
            if (firstTextMs === null) firstTextMs = Date.now() - started
            onText?.(part.text)
          }
        }
      }
    }
    return { parts, usage, firstTextMs }
  }

  /**
   * One turn: Hidde's words with the state of today, tool rounds as needed, the answer.
   * `onText` gets the words as they come, for speech that starts before the answer is done.
   */
  async turn(userText: string, state: string, runTool: ToolRunner, onText?: (delta: string) => void): Promise<BrainTurn> {
    const cacheUsd = (await this.ensureCache()) + this.warmUsd
    this.warmUsd = 0
    // Timed from here: in the app the cache is made while Jarvis opens (warm()), not while
    // Hidde waits for an answer.
    const started = Date.now()
    const usage: JarvisLiveUsage = { provider: 'gemini', textIn: 0, audioIn: 0, textOut: 0, audioOut: 0, thoughts: 0, textInCached: 0 }
    // The state rides on the newest message only; older messages keep just what was said.
    const said: Content = { role: 'user', parts: [{ text: `<stand>\n${state}\n</stand>\n\n${userText}` }] }
    const turnContents: Content[] = [said]
    let text = ''
    let firstTextMs: number | null = null

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const result = await this.generate([...this.history, ...turnContents], started, onText)
      usage.textIn += result.usage.promptTokenCount ?? 0
      usage.textInCached = (usage.textInCached ?? 0) + (result.usage.cachedContentTokenCount ?? 0)
      usage.textOut += result.usage.candidatesTokenCount ?? 0
      usage.thoughts += result.usage.thoughtsTokenCount ?? 0
      if (firstTextMs === null) firstTextMs = result.firstTextMs
      // The model's turn goes back exactly as it came: Gemini 3 checks its thought signatures.
      turnContents.push({ role: 'model', parts: result.parts })
      text += result.parts.filter((part) => part.text && !part.thought).map((part) => part.text).join('')
      const calls = result.parts.filter((part) => part.functionCall)
      if (calls.length === 0) break
      const responses: Part[] = []
      for (const part of calls) {
        const call = part.functionCall!
        let response: Record<string, unknown>
        try {
          response = { result: await runTool(call.name, call.args ?? {}) }
        } catch (error) {
          response = { error: error instanceof Error ? error.message : String(error) }
        }
        responses.push({ functionResponse: { ...(call.id ? { id: call.id } : {}), name: call.name, response } })
      }
      turnContents.push({ role: 'user', parts: responses })
      if (text && !/\s$/.test(text)) text += ' '
    }

    // What stays: Hidde's words without the state, the exchange of tools and answers with the
    // tool results cut to a line (the answer already used them), and only the last exchanges.
    this.history.push({ role: 'user', parts: [{ text: userText }] }, ...turnContents.slice(1))
    for (const content of this.history) {
      for (const part of content.parts) {
        if (part.functionResponse) part.functionResponse.response = { result: condense(JSON.stringify(part.functionResponse.response)) }
      }
    }
    this.history = lastExchanges(this.history, (content) => content.role === 'user' && content.parts.some((part) => part.text !== undefined))
    return { text: text.trim(), firstTextMs, usage, usd: brainUsd(usage) + cacheUsd }
  }

  /** Makes the cache before the first question, so that question does not wait for it. */
  async warm(): Promise<void> {
    this.warmUsd += await this.ensureCache()
  }

  /** What Jarvis got to say before he was cut off; the rest is dropped from the history. */
  cutOff(heardText: string): void {
    for (let index = this.history.length - 1; index >= 0; index -= 1) {
      const content = this.history[index]!
      if (content.role !== 'model') continue
      const textPart = content.parts.find((part) => part.text !== undefined && !part.thought)
      if (textPart) textPart.text = heardText
      return
    }
  }

  async close(): Promise<void> {
    if (this.cache) await this.call(this.cache.name, undefined, 'DELETE').catch(() => undefined)
    this.cache = null
  }
}

/**
 * Exchanges kept in the history, counted in Hidde's messages. Every request pays for what is
 * kept; the database is the memory, the chat is not. Six is enough for "die van net".
 */
export const KEPT_EXCHANGES = 6

/** The history from Hidde's sixth-last message on; a cut never splits a tool exchange. */
export function lastExchanges<T>(history: T[], isHisMessage: (entry: T) => boolean): T[] {
  let seen = 0
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (isHisMessage(history[index]!) && ++seen === KEPT_EXCHANGES) return history.slice(index)
  }
  return history
}

/** Dollars for a turn's tokens at Flash prices (cached input at the cached rate). */
export function brainUsd(usage: JarvisLiveUsage): number {
  const cached = Math.min(usage.textInCached ?? 0, usage.textIn)
  return ((usage.textIn - cached) * FLASH_PRICE.input + cached * FLASH_PRICE.cached + (usage.textOut + usage.thoughts) * FLASH_PRICE.output) / 1_000_000
}
