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
 *   JARVIS_LIVE_THINKING  minimal | low | medium (default) | high
 *   JARVIS_LIVE_CAP_USD   10 (default) — no new conversations past this, per calendar month
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import { GoogleGenAI, type LiveConnectConfig } from '@google/genai'

import type { JarvisLiveSession, JarvisLiveSpend, JarvisLiveUsage, TimeTrackerAPI } from '@core/contract/api.js'
import { runTool, TOOLS } from '@core/services/jarvis-tools.js'

/** Gemini Live prices per million tokens; thinking is billed as output. */
const PRICE_IN = 3 / 1_000_000
const PRICE_OUT = 12 / 1_000_000

const API_VERSION = 'v1alpha'

export interface LiveOptions {
  api: TimeTrackerAPI
  key: string
  system: string
  voice: string
  opening: string | null
  usagePath: string
}

const monthOf = (date = new Date()): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`

const cap = (): number => {
  const value = Number(process.env.JARVIS_LIVE_CAP_USD)
  return Number.isFinite(value) && value > 0 ? value : 10
}

export function readSpend(usagePath: string): JarvisLiveSpend {
  const month = monthOf()
  try {
    if (existsSync(usagePath)) {
      const stored = JSON.parse(readFileSync(usagePath, 'utf8')) as { month?: string; usd?: number }
      if (stored.month === month && typeof stored.usd === 'number') return { month, usd: stored.usd, capUsd: cap() }
    }
  } catch {
    // A damaged file starts the month again rather than blocking Jarvis.
  }
  return { month, usd: 0, capUsd: cap() }
}

export function addUsage(usagePath: string, usage: JarvisLiveUsage): JarvisLiveSpend {
  const spend = readSpend(usagePath)
  const clean = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0)
  const usd = clean(usage.promptTokens) * PRICE_IN + (clean(usage.responseTokens) + clean(usage.thoughtsTokens)) * PRICE_OUT
  const next = { month: spend.month, usd: Math.round((spend.usd + usd) * 10_000) / 10_000 }
  writeFileSync(usagePath, JSON.stringify(next), { mode: 0o600 })
  return { ...next, capUsd: spend.capUsd }
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
  const [agenda, tasks] = await Promise.all([
    runTool(api, 'get_agenda', { from: day, to: day }).catch(() => null),
    runTool(api, 'list_tasks', {}).catch(() => null)
  ])
  return `Nu: ${now.toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, ${now.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}.
Agenda van vandaag: ${JSON.stringify(agenda)}
Open taken: ${JSON.stringify(tasks)}`
}

export async function liveSession(options: LiveOptions): Promise<JarvisLiveSession> {
  const spend = readSpend(options.usagePath)
  if (spend.usd >= spend.capUsd) {
    throw new Error(`Het spraakbudget van deze maand ($${spend.capUsd}) is op. Typen werkt nog.`)
  }

  const model = process.env.JARVIS_LIVE_MODEL?.trim() || 'gemini-3.8-live-extended-thinking'
  const thinking = (process.env.JARVIS_LIVE_THINKING?.trim() || 'medium').toUpperCase()

  // Native audio models pick their language themselves; only the instruction can pin it.
  const instruction = `TAAL: je spreekt uitsluitend Nederlands. Nooit Engels, ook niet als je iets niet goed
verstaat of als een tool Engelse tekst teruggeeft.

${options.system}

--- LIVE ---
Dit is een live spraakgesprek: Hidde hoort je direct. Antwoord kort en snel, altijd in het
Nederlands, en laat hem gerust onderbreken. Als je een tool gebruikt, wacht je op het resultaat
en geef je dan meteen antwoord; zeg nooit dat je later terugkomt. De stand van vandaag staat hieronder; haal alleen iets op met
een tool als het over een andere dag gaat of als er iets veranderd kan zijn.

--- VANDAAG ---
${await today(options.api)}`

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
          parameters: toSchema(tool.parameters) as never,
          // The default on 3.8 Live is to call tools in the background and carry on talking
          // ("I'll let you know"). The tools here answer in milliseconds: wait for them.
          behavior: 'BLOCKING' as never
        }))
      }
    ],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    // Long conversations keep going: older turns are folded away instead of ending the session.
    contextWindowCompression: { slidingWindow: {} },
    realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: 700 } }
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
    token: token.name,
    apiVersion: API_VERSION,
    model,
    config: config as Record<string, unknown>,
    opening: options.opening,
    spend
  }
}
