/**
 * End-to-end check of Jarvis on OpenAI Realtime: a real client secret from openaiSession(),
 * a real WebSocket, Dutch questions typed and spoken, and the tools running on a copy of
 * this machine's database (the real one is never touched).
 *
 *   npm run test:openai                 typed turns plus one spoken turn (about $0.05)
 *   SESSION_OUT=file npm run test:openai  only writes a session for the Electron harness
 *
 * Needs OPENAI_API_KEY and GEMINI_API_KEY (for the spoken question) in .env.local.
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createBackend } from '@backend/create.js'
import { installHost, unavailable, type Host } from '@backend/host.js'
import { buildImplementation } from '@backend/implementation.js'
import type { JarvisLiveUsage, TimeTrackerAPI } from '@core/contract/api.js'
import { runTool } from '@core/services/jarvis-tools.js'

import { SYSTEM } from '../packages/server/app/jarvis/index.js'
import { openaiSession, usageUsd } from '../packages/server/app/jarvis/live.js'
import { speakGemini } from '../packages/server/app/jarvis/speech.js'

function key(name: string): string {
  if (process.env[name]) return process.env[name]!.trim()
  const line = existsSync('.env.local')
    ? readFileSync('.env.local', 'utf8').split(/\r?\n/).find((entry) => entry.startsWith(`${name}=`))
    : undefined
  if (line) return line.slice(name.length + 1).trim()
  throw new Error(`Geen ${name}: zet hem in .env.local.`)
}

const work = mkdtempSync(join(tmpdir(), 'uurwerk-openai-'))
const appData = process.env.APPDATA ?? join(process.env.USERPROFILE ?? '.', 'AppData', 'Roaming')
const realDb = join(appData, 'uurwerk', 'uurwerk', 'app.db')
const dbCopy = join(work, 'app.db')
if (existsSync(realDb)) copyFileSync(realDb, dbCopy)

installHost({
  emit: () => undefined,
  secrets: { get: () => null, set: () => undefined, has: () => false },
  reportDir: () => work,
  openPath: unavailable('open'),
  openExternal: unavailable('open'),
  showItemInFolder: () => undefined,
  capture: { markNow: unavailable('capture'), buildTimelapse: unavailable('timelapse') },
  startup: { getLoginItemStatus: unavailable('startup'), setAutoLaunch: unavailable('startup') },
  window: { minimizeToTray: unavailable('w'), closeQuickAdd: unavailable('w'), quit: unavailable('w') },
  relaunch: unavailable('relaunch'),
  sync: { status: unavailable('s'), pair: unavailable('s'), now: unavailable('s'), unpair: unavailable('s') },
  fileFor: (artifact) => artifact.path
} satisfies Host)
const api = buildImplementation(createBackend(existsSync(dbCopy) ? dbCopy : ':memory:')) as unknown as TimeTrackerAPI

const DUTCH = /\b(de|het|een|je|jij|en|is|op|van|morgen|vandaag|niet|staat|heb|hebt|om|uur|er|geen|wat|nog|dan|dat|met)\b/gi
const ENGLISH = /\b(the|you|and|will|let|know|your|have|is|of|to|there|tomorrow|today|what|with)\b/gi

interface Event {
  type: string
  delta?: string
  transcript?: string
  error?: { message?: string; code?: string }
  response?: {
    status?: string
    status_details?: unknown
    output?: Array<{ type: string; call_id?: string; name?: string; arguments?: string }>
    usage?: {
      input_token_details?: { text_tokens?: number; audio_tokens?: number; cached_tokens_details?: { text_tokens?: number; audio_tokens?: number } }
      output_token_details?: { text_tokens?: number; audio_tokens?: number }
    }
  }
}

interface Outcome {
  name: string
  heard: string
  reply: string
  tools: string[]
  firstAudioMs: number | null
  problems: string[]
}

/** A response refused for the per-minute limit: how long to wait before asking again. */
function retryAfter(details: unknown): number | null {
  const error = (details as { error?: { code?: string; message?: string } } | undefined)?.error
  if (error?.code !== 'rate_limit_exceeded') return null
  const seconds = Number(/try again in ([\d.]+)\s*s/i.exec(error.message ?? '')?.[1] ?? 5)
  return Math.min(20_000, seconds * 1000 + 500)
}

const usage: JarvisLiveUsage = { provider: 'openai', textIn: 0, audioIn: 0, textOut: 0, audioOut: 0, thoughts: 0, textInCached: 0, audioInCached: 0 }

async function main(): Promise<void> {
  const session = await openaiSession({ api, key: key('OPENAI_API_KEY'), system: SYSTEM, voice: '', opening: null, usagePath: join(work, 'spend.json') })
  if (process.env.SESSION_OUT) {
    writeFileSync(process.env.SESSION_OUT, JSON.stringify(session))
    console.log(`sessie voor ${session.model} geschreven naar ${process.env.SESSION_OUT}`)
    return
  }
  console.log(`sessie: ${session.model}`)

  const socket = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(session.model)}`, [
    'realtime',
    `openai-insecure-api-key.${session.token}`
  ])
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = () => reject(new Error('geen verbinding'))
    socket.onclose = (event) => reject(new Error(`dicht: ${event.code} ${event.reason}`))
  })
  const send = (event: Record<string, unknown>): void => socket.send(JSON.stringify(event))

  let handler: ((event: Event) => void) | null = null
  socket.onmessage = (message) => {
    const event = JSON.parse(String(message.data)) as Event
    if (event.type === 'error') console.log('   ! fout:', event.error?.message)
    if (process.env.DEBUG) console.log('   <', event.type)
    handler?.(event)
  }

  /** One exchange: resolves when an answer with speech comes after every tool call. */
  const exchange = (name: string, start: () => void | Promise<void>): Promise<Outcome> =>
    new Promise((resolve) => {
      const outcome: Outcome = { name, heard: '', reply: '', tools: [], firstAudioMs: null, problems: [] }
      let sentAt = Date.now()
      const timer = setTimeout(() => {
        outcome.problems.push('time-out (40 s)')
        done()
      }, 40_000)
      const done = (): void => {
        clearTimeout(timer)
        handler = null
        resolve(outcome)
      }
      handler = (event) => {
        if (event.type === 'input_audio_buffer.speech_stopped') sentAt = Date.now()
        if (event.type === 'conversation.item.input_audio_transcription.completed') outcome.heard = event.transcript ?? ''
        if (event.type === 'response.output_audio.delta' && outcome.firstAudioMs === null) outcome.firstAudioMs = Date.now() - sentAt
        if (event.type === 'response.output_audio_transcript.delta') outcome.reply += event.delta ?? ''
        if (event.type !== 'response.done') return
        const response = event.response
        const u = response?.usage
        if (u) {
          usage.textIn += u.input_token_details?.text_tokens ?? 0
          usage.audioIn += u.input_token_details?.audio_tokens ?? 0
          usage.textInCached! += u.input_token_details?.cached_tokens_details?.text_tokens ?? 0
          usage.audioInCached! += u.input_token_details?.cached_tokens_details?.audio_tokens ?? 0
          usage.textOut += u.output_token_details?.text_tokens ?? 0
          usage.audioOut += u.output_token_details?.audio_tokens ?? 0
        }
        const wait = retryAfter(response?.status_details)
        if (wait !== null) {
          console.log(`   limiet: over ${(wait / 1000).toFixed(1)} s opnieuw`)
          setTimeout(() => send({ type: 'response.create' }), wait)
          return
        }
        if (response?.status && response.status !== 'completed') console.log('   status', response.status, JSON.stringify(response.status_details))
        const calls = (response?.output ?? []).filter((item) => item.type === 'function_call')
        if (calls.length === 0) {
          done()
          return
        }
        void Promise.all(
          calls.map(async (call) => {
            outcome.tools.push(call.name ?? '?')
            let result: unknown
            try {
              result = { result: await runTool(api, call.name ?? '', JSON.parse(call.arguments || '{}') as Record<string, unknown>) }
            } catch (error) {
              result = { error: String(error) }
            }
            send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) } })
          })
        ).then(() => send({ type: 'response.create' }))
      }
      void start()
    })

  const typed = (text: string) => () => {
    send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
    send({ type: 'response.create' })
  }

  const spoken = (text: string) => async () => {
    const wav = await speakGemini(text, key('GEMINI_API_KEY'), 'Kore', 'gemini-3.8-flash-lite-tts')
    const pcm = new Uint8Array(wav.buffer.slice(wav.byteOffset + 44, wav.byteOffset + wav.byteLength))
    // Streamed like the phone: 40 ms chunks, then 2 s of silence (the gate's hangover).
    const chunk = 960 * 2
    const silence = new Uint8Array(24_000 * 2 * 2)
    const all = new Uint8Array(pcm.length + silence.length)
    all.set(pcm)
    for (let at = 0; at < all.length; at += chunk) {
      send({ type: 'input_audio_buffer.append', audio: Buffer.from(all.subarray(at, at + chunk)).toString('base64') })
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
  }

  const scenarios: Array<{ name: string; start: () => void | Promise<void>; tool: string | null }> = [
    { name: 'getypt: planning morgen', start: typed('Wat staat er morgen op de planning?'), tool: null },
    { name: 'getypt: taak voorstellen', start: typed('Zet morgen om vijf uur een half uur boodschappen doen erin.'), tool: null },
    { name: 'getypt: ja', start: typed('Ja, doe maar.'), tool: 'confirm' },
    { name: 'gesproken: wat moet ik vandaag nog', start: spoken('Wat moet ik vandaag nog doen?'), tool: null }
  ]

  const outcomes: Outcome[] = []
  for (const scenario of scenarios) {
    console.log(`\n▶ ${scenario.name}`)
    const outcome = await exchange(scenario.name, scenario.start)
    const dutch = outcome.reply.match(DUTCH)?.length ?? 0
    const english = outcome.reply.match(ENGLISH)?.length ?? 0
    if (!outcome.reply.trim()) outcome.problems.push('geen antwoord')
    else if (dutch <= english) outcome.problems.push(`niet Nederlands (nl ${dutch} / en ${english})`)
    if (scenario.tool && !outcome.tools.includes(scenario.tool)) outcome.problems.push(`tool ${scenario.tool} niet gebruikt`)
    if (outcome.heard) console.log(`   gehoord: "${outcome.heard}"`)
    console.log(`   tools: ${outcome.tools.join(', ') || '-'}; eerste geluid na ${outcome.firstAudioMs ?? '?'} ms`)
    console.log(`   Jarvis: ${outcome.reply.trim()}`)
    console.log(`   ${outcome.problems.length ? '✗ ' + outcome.problems.join('; ') : '✓'}`)
    outcomes.push(outcome)
  }
  socket.close(1000)

  console.log(`\ntokens: ${JSON.stringify(usage)}`)
  console.log(`kosten: $${usageUsd(usage).toFixed(4)}`)
  const failed = outcomes.filter((outcome) => outcome.problems.length > 0)
  console.log(failed.length ? `\n${failed.length} van ${outcomes.length} mislukt` : `\nalles ✓ (${outcomes.length})`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
