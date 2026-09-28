/**
 * End-to-end check of Jarvis's own voice line (packages/server/app/jarvis/voice.ts), run on
 * this machine: a local server with the real gateway, the real Gemini Flash, transcription
 * and Edge voice, and a fake device that speaks recorded Dutch and runs the tools on a copy
 * of the database. Measures what matters in the car: from the end of a sentence to his
 * first word.
 *
 *   npm run test:cascade          three spoken turns (a few cents)
 *   SERVE=1 npm run test:cascade  only the local server (port 8799, GET /ticket), for the
 *                                 Electron harness that tests the app's side
 *
 * Needs GEMINI_API_KEY and OPENAI_API_KEY in .env.local.
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createBackend } from '@backend/create.js'
import { installHost, unavailable, type Host } from '@backend/host.js'
import { buildImplementation } from '@backend/implementation.js'
import type { TimeTrackerAPI } from '@core/contract/api.js'
import { runTool } from '@core/services/jarvis-tools.js'

import { SYSTEM } from '../packages/server/app/jarvis/index.js'
import { configureVoice, handleVoiceUpgrade, VOICE_PATH, voiceBusy, voiceTicket } from '../packages/server/app/jarvis/voice.js'
import { speakGemini } from '../packages/server/app/jarvis/speech.js'

function key(name: string): string {
  if (process.env[name]) return process.env[name]!.trim()
  const line = existsSync('.env.local')
    ? readFileSync('.env.local', 'utf8').split(/\r?\n/).find((entry) => entry.startsWith(`${name}=`))
    : undefined
  if (line) return line.slice(name.length + 1).trim()
  throw new Error(`Geen ${name}: zet hem in .env.local.`)
}

const work = mkdtempSync(join(tmpdir(), 'uurwerk-cascade-'))
const realDb = join(process.env.APPDATA ?? '', 'uurwerk', 'uurwerk', 'app.db')
const dbCopy = join(work, 'app.db')
copyFileSync(realDb, dbCopy)

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
const api = buildImplementation(createBackend(dbCopy)) as unknown as TimeTrackerAPI

const keys: Record<string, string | null> = {
  geminiKey: key('GEMINI_API_KEY'),
  openaiKey: key('OPENAI_API_KEY'),
  // FLUX=0 runs the line without Deepgram (the OpenAI listener and the gate's pause).
  deepgramKey: process.env.FLUX === '0' ? null : key('DEEPGRAM_API_KEY')
}
const usagePath = join(work, 'spend.json')
configureVoice({ api, secret: (name) => keys[name] ?? null, usagePath, system: SYSTEM })

const PORT = 8799
const server = createServer((request, response) => {
  if (request.url === '/ticket') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ token: voiceTicket(null), url: `ws://localhost:${PORT}${VOICE_PATH}` }))
    return
  }
  response.writeHead(404).end()
})
server.on('upgrade', (request, socket, head) => {
  if (!handleVoiceUpgrade(request, socket, head, new URL(request.url ?? '/', `http://localhost:${PORT}`))) socket.destroy()
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Dutch speech, 24 kHz 16-bit mono, cached like the benchmark's clips. */
async function clip(text: string): Promise<Buffer> {
  const { createHash } = await import('node:crypto')
  const file = join('node_modules', '.cache', 'uurwerk', 'bench-voice', `${createHash('sha1').update(text).digest('hex').slice(0, 12)}.pcm`)
  if (existsSync(file)) return readFileSync(file)
  const wavBytes = await speakGemini(text, keys.geminiKey!, 'Kore', 'gemini-3.8-flash-lite-tts')
  const pcm = Buffer.from(wavBytes.buffer, wavBytes.byteOffset + 44, wavBytes.byteLength - 44)
  writeFileSync(file, pcm)
  return pcm
}

interface Turn {
  said: string
  heard: string
  reply: string
  tools: string[]
  heardMs: number | null
  firstTextMs: number | null
  firstAudioMs: number | null
  doneMs: number | null
  sentences: number
}

async function main(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(PORT, resolve))
  if (process.env.SERVE) {
    console.log(`Eigen lijn draait op ws://localhost:${PORT}${VOICE_PATH} (ticket: GET /ticket). Ctrl+C stopt.`)
    return
  }

  let socket!: WebSocket
  let turn: Turn | null = null
  let ended = 0
  let done: (() => void) | null = null
  const connect = async (): Promise<void> => {
    socket = new WebSocket(`ws://localhost:${PORT}${VOICE_PATH}?t=${voiceTicket(null)}`)
    socket.binaryType = 'arraybuffer'
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = () => reject(new Error('geen verbinding'))
    })
    socket.onmessage = receive
  }
  const receive = (message: MessageEvent): void => {
    const event = JSON.parse(String(message.data)) as { type: string; text?: string; delta?: string; data?: string; id?: string; name?: string; args?: Record<string, unknown>; message?: string }
    if (!turn) return
    const since = Date.now() - ended
    switch (event.type) {
      case 'timing':
        console.log('   (stand ophalen', (event as { state?: number }).state, 'ms)')
        break
      case 'heard':
        turn.heard = event.text ?? ''
        turn.heardMs = since
        break
      case 'reply_text':
        if (turn.firstTextMs === null) turn.firstTextMs = since
        turn.reply += event.delta ?? ''
        break
      case 'audio_mp3':
        turn.sentences += 1
        if (turn.firstAudioMs === null) turn.firstAudioMs = since
        break
      case 'tool_call':
        turn.tools.push(event.name ?? '?')
        void (async () => {
          let result: unknown
          try {
            result = { result: await runTool(api, event.name ?? '', event.args ?? {}) }
          } catch (error) {
            result = { error: String(error) }
          }
          socket.send(JSON.stringify({ type: 'tool_result', id: event.id, result }))
        })()
        break
      case 'turn_done':
        turn.doneMs = since
        done?.()
        break
      case 'error':
        turn.reply += ` [FOUT: ${event.message}]`
        done?.()
        break
    }
  }

  await connect()
  await sleep(300)
  // A second device may not start a conversation now.
  const busyWhileTalking = voiceBusy()

  const say = async (text: string): Promise<Turn> => {
    const pcm = await clip(text)
    turn = { said: text, heard: '', reply: '', tools: [], heardMs: null, firstTextMs: null, firstAudioMs: null, doneMs: null, sentences: 0 }
    for (let at = 0; at < pcm.length; at += 1920) {
      socket.send(pcm.subarray(at, at + 1920))
      await sleep(40)
    }
    // Timed from his last word. The app's gate then sends 0.9 s of quiet and says 'end';
    // with Flux the answer is already under way by then.
    ended = Date.now()
    const finished = new Promise<void>((resolve) => (done = resolve))
    for (let quiet = 0; quiet < 900; quiet += 40) {
      socket.send(Buffer.alloc(1920))
      await sleep(40)
    }
    socket.send(JSON.stringify({ type: 'end' }))
    await Promise.race([finished, sleep(40_000)])
    return turn
  }

  const lines = ['Wat staat er morgen op de planning?', 'Zet morgenavond om acht uur een uur kast fixen erin.', 'Ja, doe maar.']
  let problems = 0
  for (const line of lines) {
    const result = await say(line)
    const ok = result.doneMs !== null && result.firstAudioMs !== null && result.reply.trim().length > 0
    if (!ok) problems += 1
    console.log(`\n${ok ? '✓' : '✗'} "${line}"`)
    console.log(`   verstaan (${result.heardMs ?? '–'} ms): "${result.heard}"`)
    console.log(`   eerste tekst na ${result.firstTextMs ?? '–'} ms (denken ${result.firstTextMs !== null && result.heardMs !== null ? result.firstTextMs - result.heardMs : '–'} ms), eerste woord na ${result.firstAudioMs ?? '–'} ms (stem ${result.firstAudioMs !== null && result.firstTextMs !== null ? result.firstAudioMs - result.firstTextMs : '–'} ms), klaar na ${result.doneMs ?? '–'} ms, ${result.sentences} zinnen, tools: ${result.tools.join(', ') || '-'}`)
    console.log(`   Jarvis: ${result.reply.trim()}`)
  }
  // A new conversation a moment later carries on from this one.
  socket.close(1000)
  await sleep(2000)
  await connect()
  const again = await say('Wat hebben we net samen ingepland?')
  const remembers = /kast/i.test(again.reply)
  if (!remembers) problems += 1
  console.log(`
${remembers ? '✓' : '✗'} nieuw gesprek, "Wat hebben we net samen ingepland?"
   Jarvis: ${again.reply.trim()}`)
  socket.close(1000)
  await sleep(3000)
  const freeAfter = !voiceBusy()
  if (!busyWhileTalking || !freeAfter) problems += 1
  console.log(`\n${busyWhileTalking && freeAfter ? '✓' : '✗'} één gesprek tegelijk: bezet tijdens het gesprek ${busyWhileTalking}, vrij erna ${freeAfter}`)
  console.log(`\nkosten (server-teller): ${existsSync(usagePath) ? readFileSync(usagePath, 'utf8') : '–'}`)
  const blocks = (await api.plans.day(new Date(Date.now() + 86_400_000).toISOString().slice(0, 10))).blocks.filter((block) => /kast/i.test(block.taskTitle ?? ''))
  console.log(`kast fixen in de planning van morgen: ${blocks.map((block) => `${block.startMin / 60}:00`).join(', ') || 'niet'}`)
  server.close()
  process.exit(problems ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
