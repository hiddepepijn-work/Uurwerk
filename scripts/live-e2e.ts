/**
 * Jarvis live, end to end, before anything goes to the phone.
 *
 * Does what the app does, against the real Gemini Live: gets a token from the server code
 * (brief, tools and today locked in), connects with it, speaks real Dutch audio into the
 * microphone stream, runs the tools the model asks for on a copy of this laptop's database,
 * answers them the way the app does, and checks the replies: Dutch, and actually answering
 * rather than promising to come back.
 *
 *   npm run test:live
 *
 * Needs GEMINI_API_KEY, in the environment or in .env.local (git-ignored). Costs a few
 * cents per run. Writes nothing to the real database: the tools run on a temporary copy.
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GoogleGenAI, type LiveServerMessage, type Session } from '@google/genai'

import { createBackend } from '@backend/create.js'
import { installHost, unavailable, type Host } from '@backend/host.js'
import { buildImplementation } from '@backend/implementation.js'
import type { TimeTrackerAPI } from '@core/contract/api.js'
import { runTool } from '@core/services/jarvis-tools.js'

import { MOMENT, SYSTEM } from '../packages/server/app/jarvis/index.js'
import { addUsage, liveSession } from '../packages/server/app/jarvis/live.js'
import { speakGemini } from '../packages/server/app/jarvis/speech.js'

// ------------------------------------------------------------------ setup

function geminiKey(): string {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim()
  if (existsSync('.env.local')) {
    const line = readFileSync('.env.local', 'utf8')
      .split(/\r?\n/)
      .find((entry) => entry.startsWith('GEMINI_API_KEY='))
    if (line) return line.slice('GEMINI_API_KEY='.length).trim()
  }
  throw new Error('Geen GEMINI_API_KEY: zet hem in .env.local (GEMINI_API_KEY=...) of in de omgeving.')
}

const work = mkdtempSync(join(tmpdir(), 'uurwerk-live-'))
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

// ------------------------------------------------------------------ audio

/** Dutch speech as the phone would send it: 16 kHz 16-bit mono PCM. */
async function voice(key: string, text: string): Promise<Int16Array> {
  const wav = await speakGemini(text, key, 'Kore', 'gemini-3.8-flash-tts')
  const pcm24 = new Int16Array(wav.buffer.slice(wav.byteOffset + 44, wav.byteOffset + wav.byteLength))
  const out = new Int16Array(Math.floor((pcm24.length * 2) / 3))
  for (let i = 0; i < out.length; i++) {
    const at = (i * 3) / 2
    const low = Math.floor(at)
    const high = Math.min(low + 1, pcm24.length - 1)
    out[i] = Math.round(pcm24[low]! + (pcm24[high]! - pcm24[low]!) * (at - low))
  }
  return out
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------- checks

const DUTCH = /\b(de|het|een|je|jij|en|is|op|van|morgen|vandaag|niet|staat|heb|hebt|om|uur|er|geen|wat|nog|dan|dat|met)\b/gi
const ENGLISH = /\b(the|you|and|will|let|know|your|have|is|of|to|there|tomorrow|today|what|with)\b/gi
const PROMISE = /(let you know|get back to you|kom (er )?(later )?(op )?terug|laat (het )?(je )?weten zodra)/i

interface Outcome {
  name: string
  reply: string
  tools: string[]
  firstAudioMs: number | null
  problems: string[]
}

interface Usage {
  textIn: number
  audioIn: number
  textOut: number
  audioOut: number
  thoughts: number
}

function judge(outcome: Outcome, expectTool: string | null): void {
  const dutch = outcome.reply.match(DUTCH)?.length ?? 0
  const english = outcome.reply.match(ENGLISH)?.length ?? 0
  if (!outcome.reply.trim()) outcome.problems.push('geen antwoord')
  else if (dutch <= english) outcome.problems.push(`niet Nederlands (nl ${dutch} / en ${english})`)
  if (PROMISE.test(outcome.reply)) outcome.problems.push('belooft later terug te komen')
  if (expectTool && !outcome.tools.includes(expectTool)) outcome.problems.push(`tool ${expectTool} niet gebruikt`)
}

// ------------------------------------------------------------- one round

/**
 * One exchange on an open session. Resolves once a turn completes with speech after every
 * tool call has been answered — the way the app would hear it.
 */
function exchange(session: Session, inbox: { handler: ((message: LiveServerMessage) => void) | null }, usage: Usage, send: () => Promise<void>, name: string): Promise<Outcome> {
  return new Promise((resolve) => {
    const outcome: Outcome = { name, reply: '', tools: [], firstAudioMs: null, problems: [] }
    let sentAt = 0
    let pendingTools = 0
    let spokeAfterTools = false
    let heardAudio = false
    const timer = setTimeout(() => {
      outcome.problems.push('time-out (30 s)')
      finish()
    }, 30_000)
    const finish = (): void => {
      clearTimeout(timer)
      inbox.handler = null
      resolve(outcome)
    }

    inbox.handler = (message) => {
      const content = message.serverContent
      if (content?.modelTurn?.parts?.some((part) => part.inlineData?.data)) {
        heardAudio = true
        if (outcome.firstAudioMs === null && sentAt) outcome.firstAudioMs = Date.now() - sentAt
        if (pendingTools === 0 && outcome.tools.length > 0) spokeAfterTools = true
      }
      if (content?.outputTranscription?.text) outcome.reply += content.outputTranscription.text
      if (message.usageMetadata) {
        const meta = message.usageMetadata
        for (const entry of meta.promptTokensDetails ?? []) {
          if (String(entry.modality) === 'TEXT') usage.textIn += entry.tokenCount ?? 0
          else usage.audioIn += entry.tokenCount ?? 0
        }
        for (const entry of meta.responseTokensDetails ?? []) {
          if (String(entry.modality) === 'TEXT') usage.textOut += entry.tokenCount ?? 0
          else usage.audioOut += entry.tokenCount ?? 0
        }
        usage.thoughts += meta.thoughtsTokenCount ?? 0
        if (process.env.LIVE_DEBUG) console.log('   usage', JSON.stringify({ prompt: meta.promptTokenCount, cached: meta.cachedContentTokenCount, cacheDetails: meta.cacheTokensDetails, response: meta.responseTokenCount, thoughts: meta.thoughtsTokenCount, tool: meta.toolUsePromptTokenCount }))
      }
      if (message.toolCall?.functionCalls?.length) {
        const calls = message.toolCall.functionCalls
        pendingTools += calls.length
        void Promise.all(
          calls.map(async (call) => {
            outcome.tools.push(call.name ?? '?')
            try {
              const result = await runTool(api, call.name ?? '', (call.args ?? {}) as Record<string, unknown>)
              return { id: call.id, name: call.name, response: { result } }
            } catch (error) {
              return { id: call.id, name: call.name, response: { error: String(error) } }
            }
          })
        ).then((responses) => {
          pendingTools -= responses.length
          session.sendToolResponse({ functionResponses: responses })
        })
      }
      if (content?.turnComplete && heardAudio && pendingTools === 0) {
        // IN_PROGRESS: that was "even kijken", the answer is still coming.
        const idle = String(content.interactionStatus ?? 'IDLE') !== 'IN_PROGRESS'
        if (idle && (outcome.tools.length === 0 || spokeAfterTools)) finish()
      }
    }

    void send().then(() => {
      sentAt = Date.now()
    })
  })
}

// ------------------------------------------------------------------- run

async function main(): Promise<void> {
  const key = geminiKey()
  const usagePath = join(work, 'spend.json')

  console.log('Stem opnemen voor de testvragen…')
  const [tomorrow, today] = await Promise.all([
    voice(key, 'Wat staat er morgen op de planning?'),
    voice(key, 'Wat heb ik vandaag nog te doen?')
  ])

  const outcomes: Outcome[] = []
  const usage: Usage = { textIn: 0, audioIn: 0, textOut: 0, audioOut: 0, thoughts: 0 }

  async function connect(moment: 'morning' | 'evening' | null): Promise<{ session: Session; inbox: { handler: ((message: LiveServerMessage) => void) | null }; opening: string | null; closed: string[] }> {
    const started = Date.now()
    const live = await liveSession({ api, key, system: SYSTEM, voice: 'Orus', opening: moment ? MOMENT[moment] : null, usagePath })
    const inbox: { handler: ((message: LiveServerMessage) => void) | null } = { handler: null }
    const closed: string[] = []
    const ai = new GoogleGenAI({ apiKey: live.token, httpOptions: { apiVersion: live.apiVersion } })
    const session = await ai.live.connect({
      model: live.model,
      config: live.config,
      callbacks: {
        onmessage: (message) => inbox.handler?.(message),
        onerror: (event) => closed.push(`fout: ${event.message}`),
        onclose: (event) => {
          if (event.code !== 1000) closed.push(`gesloten ${event.code}: ${event.reason}`)
        }
      }
    })
    console.log(`Verbonden met ${live.model} in ${Date.now() - started} ms (token + verbinding).`)
    return { session, inbox, opening: live.opening, closed }
  }

  const speakInto = async (session: Session, pcm: Int16Array): Promise<void> => {
    // 40 ms chunks, then the 1.5 s of quiet the app's gate lets through, then "microphone
    // paused" — as the app does. Silence goes at real time: the model measures it.
    const chunk = (samples: Int16Array): void =>
      session.sendRealtimeInput({ audio: { data: Buffer.from(samples.buffer).toString('base64'), mimeType: 'audio/pcm;rate=16000' } })
    for (let at = 0; at < pcm.length; at += 640) {
      chunk(pcm.slice(at, at + 640))
      await sleep(10)
    }
    for (let quiet = 0; quiet < 1500; quiet += 40) {
      chunk(new Int16Array(640))
      await sleep(40)
    }
    session.sendRealtimeInput({ audioStreamEnd: true })
  }

  // 1 and 2: spoken questions, one conversation.
  {
    const { session, inbox, closed } = await connect(null)
    const first = await exchange(session, inbox, usage, () => speakInto(session, tomorrow), 'gesproken: morgen')
    judge(first, 'get_agenda')
    outcomes.push(first)
    const second = await exchange(session, inbox, usage, () => speakInto(session, today), 'gesproken: vandaag')
    judge(second, null)
    outcomes.push(second)
    for (const problem of closed) second.problems.push(problem)
    session.close()
  }

  // 3: the morning moment, opened by Jarvis himself.
  {
    const { session, inbox, opening, closed } = await connect('morning')
    const morning = await exchange(
      session,
      inbox,
      usage,
      async () => session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: opening ?? '' }] }], turnComplete: true }),
      'ochtendmoment'
    )
    judge(morning, null)
    for (const problem of closed) morning.problems.push(problem)
    outcomes.push(morning)
    session.close()
  }

  const spend = addUsage(usagePath, usage)
  console.log('')
  for (const outcome of outcomes) {
    const mark = outcome.problems.length === 0 ? '✓' : '✗'
    console.log(`${mark} ${outcome.name}  (eerste geluid ${outcome.firstAudioMs ?? '–'} ms, tools: ${outcome.tools.join(', ') || 'geen'})`)
    console.log(`    “${outcome.reply.trim().slice(0, 300)}”`)
    for (const problem of outcome.problems) console.log(`    ! ${problem}`)
  }
  console.log(`\nKosten van deze run: $${spend.usd.toFixed(4)}  (${JSON.stringify(usage)})`)

  rmSync(work, { recursive: true, force: true })
  if (outcomes.some((outcome) => outcome.problems.length > 0)) process.exit(1)
  process.exit(0)
}

main().catch((error: unknown) => {
  console.error('✗', error instanceof Error ? error.message : error)
  rmSync(work, { recursive: true, force: true })
  process.exit(1)
})
