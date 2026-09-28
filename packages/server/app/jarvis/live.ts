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

const isoDay = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const WEEKDAYS = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za']

/**
 * The dates of this week and next, named. The benchmark showed the models get "volgende week
 * donderdag" wrong when they work it out themselves; looked up, it is always right.
 */
export function dateTable(now = new Date()): string {
  const weekday = (now.getDay() + 6) % 7
  const thisWeek: string[] = []
  const nextWeek: string[] = []
  for (let offset = 0; offset < 14 - weekday; offset += 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
    const label = offset === 0 ? ' (vandaag)' : offset === 1 ? ' (morgen)' : ''
    ;(offset < 7 - weekday ? thisWeek : nextWeek).push(`${WEEKDAYS[date.getDay()]} ${isoDay(date)}${label}`)
  }
  return `Datums deze week: ${thisWeek.join(', ')} | volgende week: ${nextWeek.join(', ')}`
}

/** Hours planned from now to Sunday, per area: questions like "hoeveel uur stage nog" read it off. */
async function weekHours(api: TimeTrackerAPI, now = new Date()): Promise<string> {
  const weekday = (now.getDay() + 6) % 7
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const perArea = new Map<string, number>()
  for (let offset = 0; offset < 7 - weekday; offset += 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
    const blocks = (await api.plans.day(isoDay(date))).blocks.filter((block) => block.kind === 'task')
    for (const block of blocks) {
      const start = offset === 0 ? Math.max(block.startMin, nowMin) : block.startMin
      if (block.endMin > start) perArea.set(block.areaId ?? '?', (perArea.get(block.areaId ?? '?') ?? 0) + block.endMin - start)
    }
  }
  const parts = [...perArea].map(([area, minutes]) => `${area} ${(minutes / 60).toFixed(1).replace('.', ',')} u`)
  return `Nog gepland van nu t/m zondag: ${parts.join(', ') || 'niets'}.`
}

/** Today in a few lines, so the first questions need no tools. */
async function today(api: TimeTrackerAPI): Promise<string> {
  const now = new Date()
  // Compact text, not JSON: the same facts in a fraction of the tokens, read every turn.
  const snapshot = await runTool(api, 'get_snapshot', { from: isoDay(now) }).catch(() => null)
  const hours = await weekHours(api, now).catch(() => '')
  return `Nu: ${now.toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, ${now.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}.
${dateTable(now)}
${hours}
${typeof snapshot === 'string' ? snapshot : '(stand niet beschikbaar)'}`
}

/**
 * The brief's section on the morning and the evening only when the conversation opens with
 * one of them: every other conversation would pay for it on every turn.
 */
function withoutMoments(system: string): string {
  const start = system.indexOf('\n## De vaste momenten')
  if (start < 0) return system
  const end = system.indexOf('\n## ', start + 1)
  const note = '\n## De vaste momenten\n(Ochtend 08:30 en dagafsluiting 21:00: je krijgt de stappen als het gesprek daarmee opent.)\n'
  return system.slice(0, start) + note + (end < 0 ? '' : system.slice(end))
}

/**
 * What a live conversation starts from: the language, his brief and rules, how to talk
 * live, and the state of today. The same for Gemini and OpenAI.
 */
async function instructionFor(options: LiveOptions): Promise<string> {
  return `${fixedInstruction(options)}

--- VANDAAG ---
${await today(options.api)}`
}

/**
 * The instruction in two parts: what stays the same all month (cacheable, so it goes first)
 * and the state of today (a few hundred tokens, changes with every edit). A cascade sends the
 * fixed part as its system prompt and the state along with each message.
 */
export function instructionParts(options: Pick<LiveOptions, 'api' | 'system' | 'opening'>): {
  fixed: string
  state: () => Promise<string>
} {
  return { fixed: fixedInstruction(options), state: () => today(options.api) }
}

function fixedInstruction(options: Pick<LiveOptions, 'system' | 'opening'>): string {
  // Native audio models pick their language themselves; only the instruction can pin it.
  return `TAAL: je spreekt uitsluitend Nederlands. Nooit Engels, ook niet als je iets niet goed
verstaat of als een tool Engelse tekst teruggeeft.

${options.opening ? options.system : withoutMoments(options.system)}

--- LIVE ---
Dit is een live spraakgesprek: Hidde hoort je direct. Antwoord in hooguit twee korte zinnen
(zo'n 25 woorden), tenzij hij om een overzicht vraagt; dan de hoofdzaken, geen opsomming van
alles. Zie je een risico (een deadline die niet gaat passen, een botsing, iets te laat; in de
stand gemarkeerd met RISICO of TE LAAT), noem het één keer per gesprek als het over die dag
gaat, ook als dat een zin extra kost, en bied aan het in te plannen. Daarna niet steeds opnieuw. Altijd Nederlands, en laat hem gerust onderbreken.
Staat het antwoord hieronder al, geef het dan meteen, zonder "even kijken". Alleen als je
echt een tool aanroept zeg je hooguit "even kijken", en je geeft het antwoord zodra het
resultaat binnen is (dat duurt een fractie van een seconde).
Zeg nooit dat je later terugkomt.

De tijd, de datums van deze en volgende week, de uren die deze week nog gepland staan, de
planning van vandaag en morgen, de open taken en de regels staan hieronder al. Reken nooit
zelf een datum uit: lees hem af.
Gebruik daarvoor dus GEEN get_now, get_snapshot of list_tasks, ook niet bij het ochtend- of
avondmoment: dat kost tijd en geld. Een tool alleen voor andere dagen, of nadat er in dit gesprek iets is
veranderd.`
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
    // Thinking is billed as text, a tenth of what his speech costs: medium buys correctness
    // (dates, clashes, sums) for almost nothing. The benchmark measured it.
    reasoning: { effort: process.env.JARVIS_REALTIME_EFFORT?.trim() || 'medium' }
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
