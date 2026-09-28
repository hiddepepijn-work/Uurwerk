/**
 * Jarvis live: talking to a realtime voice model, the way the ChatGPT app does. The device
 * streams the microphone straight to Gemini Live and plays what comes back as it arrives;
 * the server only hands out a short-lived token and keeps the bill.
 *
 * The token locks the connection: model, brief, tools and voice are fixed server-side, so
 * the device cannot talk the model into anything else, and the API key never leaves here.
 * Today's agenda and open tasks go into the instruction up front, so "wat heb ik vandaag?"
 * needs no tool round. The tools themselves run on the device, against its own copy.
 *
 *   JARVIS_LIVE_MODEL     gemini-3.8-live-extended-thinking (default)
 *   JARVIS_LIVE_THINKING  minimal | low (default) | medium | high
 *   JARVIS_LIVE_CAP_USD   10 (default) — no new conversations past this, per calendar month
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import { GoogleGenAI, type LiveConnectConfig } from '@google/genai'

import type { JarvisLiveSession, JarvisLiveSpend, JarvisLiveUsage, TimeTrackerAPI } from '@core/contract/api.js'
import { runTool, TOOLS } from '@core/services/jarvis-tools.js'

/** Gemini 3.8 Live prices per million tokens; thinking counts as text output. */
const PRICE = { textIn: 0.75, audioIn: 3, textOut: 4.5, audioOut: 12, thoughts: 4.5 } as const
/** OpenAI Realtime per million tokens; what comes from its cache costs a fraction. */
const OPENAI_MINI = { textIn: 0.6, textInCached: 0.06, audioIn: 10, audioInCached: 0.3, textOut: 2.4, audioOut: 20 } as const
const OPENAI_FULL = { textIn: 4, textInCached: 0.4, audioIn: 32, audioInCached: 0.4, textOut: 24, audioOut: 64 } as const
export const openaiModel = (): string => process.env.JARVIS_REALTIME_MODEL?.trim() || 'gpt-realtime-2.1-mini'

const API_VERSION = 'v1alpha'

export interface LiveOptions {
  api: TimeTrackerAPI
  key: string
  system: string
  voice: string
  opening: string | null
  usagePath: string
  /** A dropped conversation's resumption handle: the new connection carries on from it. */
  resume?: string | null
}

const monthOf = (date = new Date()): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`

const cap = (): number => {
  const value = Number(process.env.JARVIS_LIVE_CAP_USD)
  return Number.isFinite(value) && value > 0 ? value : 10
}

const round = (usd: number): number => Math.round(usd * 10_000) / 10_000

export function readSpend(usagePath: string): JarvisLiveSpend {
  const month = monthOf()
  try {
    if (existsSync(usagePath)) {
      const stored = JSON.parse(readFileSync(usagePath, 'utf8')) as { month?: string; usd?: number; live?: number; text?: number }
      if (stored.month === month && typeof stored.usd === 'number') {
        // Files from before the split counted Live only.
        const live = typeof stored.live === 'number' ? stored.live : stored.usd
        const text = typeof stored.text === 'number' ? stored.text : 0
        return { month, usd: round(live + text), capUsd: cap(), live, text }
      }
    }
  } catch {
    // A damaged file starts the month again rather than blocking Jarvis.
  }
  return { month, usd: 0, capUsd: cap(), live: 0, text: 0 }
}

function addSpend(usagePath: string, kind: 'live' | 'text', usd: number): JarvisLiveSpend {
  const spend = readSpend(usagePath)
  const live = round(spend.live + (kind === 'live' ? usd : 0))
  const text = round(spend.text + (kind === 'text' ? usd : 0))
  writeFileSync(usagePath, JSON.stringify({ month: spend.month, usd: round(live + text), live, text }), { mode: 0o600 })
  return { month: spend.month, usd: round(live + text), capUsd: spend.capUsd, live, text }
}

/** Gemini 3.8 Flash, typed Jarvis: per million tokens, cached input at a tenth. */
const FLASH = { input: 0.75, cached: 0.075, output: 3.75 } as const

export function addTextUsage(usagePath: string, usage: { prompt: number; cached: number; output: number; thoughts: number }): JarvisLiveSpend {
  const clean = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0)
  const cached = Math.min(clean(usage.cached), clean(usage.prompt))
  const usd =
    ((clean(usage.prompt) - cached) * FLASH.input + cached * FLASH.cached + (clean(usage.output) + clean(usage.thoughts)) * FLASH.output) /
    1_000_000
  return addSpend(usagePath, 'text', usd)
}

export function addUsage(usagePath: string, usage: JarvisLiveUsage): JarvisLiveSpend {
  return addSpend(usagePath, 'live', usageUsd(usage))
}

/** What one conversation's tokens cost, at its provider's prices. */
export function usageUsd(usage: JarvisLiveUsage, model = openaiModel()): number {
  const clean = (value: number | undefined): number => (Number.isFinite(value) && value! > 0 ? value! : 0)
  if (usage.provider === 'openai') {
    // Cached input is part of the input count, and billed at the cached price instead.
    const textCached = Math.min(clean(usage.textInCached), clean(usage.textIn))
    const audioCached = Math.min(clean(usage.audioInCached), clean(usage.audioIn))
    const P = /mini/.test(model) ? OPENAI_MINI : OPENAI_FULL
    return (
      ((clean(usage.textIn) - textCached) * P.textIn +
        textCached * P.textInCached +
        (clean(usage.audioIn) - audioCached) * P.audioIn +
        audioCached * P.audioInCached +
        clean(usage.textOut) * P.textOut +
        clean(usage.audioOut) * P.audioOut) /
      1_000_000
    )
  }
  return (Object.keys(PRICE) as Array<keyof typeof PRICE>).reduce(
    (sum, kind) => sum + (clean(usage[kind]) * PRICE[kind]) / 1_000_000,
    0
  )
}

/** Gemini's schema dialect: upper-case types, no additionalProperties. */
export function toSchema(json: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (typeof json.type === 'string') out.type = json.type.toUpperCase()
  if (typeof json.description === 'string') out.description = json.description
  if (Array.isArray(json.enum)) out.enum = json.enum
  if (Array.isArray(json.required) && json.required.length > 0) out.required = json.required
  if (json.items && typeof json.items === 'object') out.items = toSchema(json.items as Record<string, unknown>)
  if (json.properties && typeof json.properties === 'object') {
    out.properties = Object.fromEntries(
      Object.entries(json.properties as Record<string, Record<string, unknown>>).map(([name, value]) => [name, toSchema(value)])
    )
  }
  return out
}

/** Today in a few lines, so the first questions need no tools. */
async function today(api: TimeTrackerAPI): Promise<string> {
  const now = new Date()
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  // Compact text, not JSON: the same facts in a fraction of the tokens, read every turn.
  const snapshot = await runTool(api, 'get_snapshot', { from: day }).catch(() => null)
  return `Nu: ${now.toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, ${now.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}.
${typeof snapshot === 'string' ? snapshot : '(stand niet beschikbaar)'}`
}

/**
 * What a live conversation starts from: the language, his brief and rules, how to talk
 * live, and the state of today. The same for Gemini and OpenAI.
 */
async function instructionFor(options: LiveOptions): Promise<string> {
  // Native audio models pick their language themselves; only the instruction can pin it.
  return `TAAL: je spreekt uitsluitend Nederlands. Nooit Engels, ook niet als je iets niet goed
verstaat of als een tool Engelse tekst teruggeeft.

${options.system}

--- LIVE ---
Dit is een live spraakgesprek: Hidde hoort je direct. Antwoord kort en snel, altijd in het
Nederlands, en laat hem gerust onderbreken. Gebruik je een tool, zeg dan hooguit "even kijken"
en geef het antwoord zodra het resultaat binnen is (dat duurt een fractie van een seconde).
Zeg nooit dat je later terugkomt.

De tijd, de planning van vandaag en morgen, de open taken en de regels staan hieronder al.
Gebruik daarvoor dus GEEN get_now, get_snapshot of list_tasks, ook niet bij het ochtend- of
avondmoment: dat kost tijd en geld. Een tool alleen voor andere dagen, of nadat er in dit gesprek iets is
veranderd.

--- VANDAAG ---
${await today(options.api)}`
}

export async function liveSession(options: LiveOptions): Promise<JarvisLiveSession> {
  const spend = readSpend(options.usagePath)
  if (spend.usd >= spend.capUsd) {
    throw new Error(`Het spraakbudget van deze maand ($${spend.capUsd}) is op. Typen werkt nog.`)
  }

  const model = process.env.JARVIS_LIVE_MODEL?.trim() || 'gemini-3.8-live-extended-thinking'
  const thinking = (process.env.JARVIS_LIVE_THINKING?.trim() || 'low').toUpperCase()

  const instruction = await instructionFor(options)

  const config: LiveConnectConfig = {
    responseModalities: ['AUDIO' as never],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voice } } },
    ...(/extended-thinking/.test(model) ? { thinkingConfig: { thinkingLevel: thinking as never } } : {}),
    systemInstruction: { parts: [{ text: instruction }] },
    tools: [
      {
        functionDeclarations: TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          // 3.8 Live only calls tools in the background: BLOCKING declarations and
          // scheduling on the responses are both refused. It answers once results are in.
          parameters: toSchema(tool.parameters) as never
        }))
      }
    ],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    // Long conversations keep going: older turns are folded away instead of ending the session.
    // Folded early: every turn re-reads what is kept, and a long talk should not cost more per turn.
    contextWindowCompression: { triggerTokens: '16000', slidingWindow: { targetTokens: '9000' } },
    // Gemini hands out resumption handles, so a dropped connection can carry on where it was.
    sessionResumption: options.resume ? { handle: options.resume } : {},
    // A breath mid-sentence is not the end of a turn: 700 ms cut Hidde's sentences in half
    // and Jarvis answered the halves.
    realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: 1200 } }
  }

  const ai = new GoogleGenAI({ apiKey: options.key, httpOptions: { apiVersion: API_VERSION } })
  const now = Date.now()
  const token = await ai.authTokens.create({
    config: {
      uses: 1,
      expireTime: new Date(now + 30 * 60_000).toISOString(),
      newSessionExpireTime: new Date(now + 2 * 60_000).toISOString(),
      liveConnectConstraints: { model, config },
      httpOptions: { apiVersion: API_VERSION }
    }
  })
  if (!token.name) throw new Error('Gemini gaf geen token terug.')

  return {
    provider: 'gemini',
    token: token.name,
    apiVersion: API_VERSION,
    model,
    config: config as Record<string, unknown>,
    opening: options.opening,
    spend
  }
}

/**
 * An OpenAI Realtime session: a short-lived client secret with the whole session locked in
 * (model, instruction, voice, tools), so the device only ever holds that secret.
 */
export async function openaiSession(options: LiveOptions): Promise<JarvisLiveSession> {
  const spend = readSpend(options.usagePath)
  if (spend.usd >= spend.capUsd) {
    throw new Error(`Het spraakbudget van deze maand ($${spend.capUsd}) is op. Typen werkt nog.`)
  }
  const model = openaiModel()
  const voice = process.env.JARVIS_REALTIME_VOICE?.trim() || 'cedar'
  const instruction = await instructionFor(options)

  const session = {
    type: 'realtime',
    model,
    instructions: instruction,
    output_modalities: ['audio'],
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: 24000 },
        transcription: { model: 'gpt-4o-mini-transcribe', language: 'nl' },
        noise_reduction: { type: 'near_field' },
        // A fixed 1.2 s of silence ends the turn, as with Gemini. Not semantic VAD: it counts
        // silence in audio it receives, waits up to 8 s, and the app stops sending 2 s after
        // Hidde does, so the turn only ended when he spoke again.
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 1200,
          create_response: true,
          interrupt_response: true
        }
      },
      output: { format: { type: 'audio/pcm', rate: 24000 }, voice }
    },
    tools: TOOLS.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      // Plain JSON Schema, as the tools are written; toSchema is Gemini's dialect.
      parameters: tool.parameters
    })),
    tool_choice: 'auto',
    reasoning: { effort: process.env.JARVIS_REALTIME_EFFORT?.trim() || 'low' }
  }

  const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${options.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expires_after: { anchor: 'created_at', seconds: 600 }, session })
  })
  const body = (await response.json().catch(() => ({}))) as { value?: string; error?: { message?: string } }
  if (!response.ok || !body.value) {
    throw new Error(`OpenAI gaf geen sessie: ${body.error?.message ?? response.status}`)
  }
  return { provider: 'openai', token: body.value, apiVersion: '', model, config: {}, opening: options.opening, spend }
}
