/**
 * Jarvis's own voice line: the cascade. The device streams its microphone here over one
 * WebSocket; this side hears it (speech to text), thinks (Gemini Flash, brain.ts) and speaks
 * (Edge's neural voice), sentence by sentence, so he starts talking before the answer is done.
 *
 * Why not a realtime model: Gemini Live cost about $0.027 a turn and cannot cache; this line
 * costs about $0.004 with the fixed instruction cached (measured 28 Sep 2026).
 *
 * The tools still run on the device, against its own copy: a tool call goes down the socket
 * and the result comes back. The keys never leave the server. A device gets in with a ticket
 * from jarvis.liveSession (it already holds a device token for that), good once, for a minute.
 *
 * Down the socket, as JSON: heard, reply_start, reply_text, audio_mp3 (one sentence each),
 * tool_call, turn_done, error. Up: binary PCM (16-bit, 24 kHz, while Hidde talks), and
 * end (he paused), text (typed), cutoff (he interrupted; ms of the answer he heard),
 * tool_result.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { isSprintCommand } from '@core/domain/sprint.js'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

import { WebSocket as WebSocketClient, WebSocketServer, type WebSocket } from 'ws'

import type { TimeTrackerAPI } from '@core/contract/api.js'

import { log } from '@backend/log.js'
import { Brain } from './brain.js'
import { addCostUsd, instructionParts } from './live.js'

export const VOICE_PATH = '/api/jarvis/voice'
const TICKET_MS = 60_000
const SAMPLE_RATE = 24_000
/** Shorter than this is a cough or a click, not a question. */
const MIN_SPEECH_S = 0.3
/** gpt-4o-mini-transcribe, per minute of audio. */
const STT_PER_MINUTE = 0.003
/** A tool call that takes longer than this has lost the device. */
const TOOL_TIMEOUT_MS = 20_000

export interface VoiceDeps {
  api: TimeTrackerAPI
  secret(name: 'geminiKey' | 'openaiKey' | 'deepgramKey'): string | null
  usagePath: string
  system: string
}

let deps: VoiceDeps | null = null

/**
 * Talks going on right now, with when each last heard anything. One at a time: on 28 Sep
 * 2026 "Goed Jarvis" on the phone woke the laptop too, which heard the phone's voice say
 * "Zal ik dat zo doen?" and his "ja", and made an appointment nobody asked for.
 */
const talking = new Map<object, number>()
const BUSY_MS = 90_000

/** Is Jarvis already in a conversation (on some device) that is still alive? */
export function voiceBusy(now = Date.now()): boolean {
  for (const last of talking.values()) if (now - last < BUSY_MS) return true
  return false
}

export const BUSY_MESSAGE = 'Jarvis is al in gesprek op je andere apparaat.'

/**
 * The last conversation, so a new one within half an hour (the same day) carries on from it:
 * "weet je nog waar we het over hadden" got a blank. One person, so one memory.
 */
let recent: { history: unknown[]; endedAt: number; day: string; id: string; turns: TurnRecord[] } | null = null

/** One exchange as it happened, for complaints: what he heard, said and did. */
interface TurnRecord {
  at: string
  heard: string
  reply: string
  tools: Array<{ name: string; args: Record<string, unknown>; result: string }>
  cut: boolean
}

/**
 * Hidde's complaints about Jarvis, one JSON line each in the data directory
 * (jarvis-feedback.jsonl): his words, Jarvis's own account, and the conversation (and the one
 * before it, if it was just now), so a mistake can be read back and fixed.
 */
function saveComplaint(usagePath: string, entry: Record<string, unknown>): string {
  const file = join(dirname(usagePath), 'jarvis-feedback.jsonl')
  const count = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0
  const number = `K${count + 1}`
  appendFileSync(file, `${JSON.stringify({ number, ...entry })}\n`, { mode: 0o600 })
  return number
}
const CARRY_ON_MS = 30 * 60_000
const dayKey = (): string => new Date().toDateString()
const tickets = new Map<string, { expires: number; opening: string | null }>()
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })

/** Set by createJarvis, again whenever the database is reopened. */
export function configureVoice(next: VoiceDeps): void {
  deps = next
}

/** A one-time ticket for the voice line; the opening (morning, evening) rides along. */
export function voiceTicket(opening: string | null): string {
  const now = Date.now()
  for (const [token, ticket] of tickets) if (ticket.expires < now) tickets.delete(token)
  const token = randomBytes(24).toString('base64url')
  tickets.set(token, { expires: now + TICKET_MS, opening })
  return token
}

/** The HTTP server's upgrade event, for our path. True when it was ours to take. */
export function handleVoiceUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, url: URL): boolean {
  if (url.pathname !== VOICE_PATH) return false
  const token = url.searchParams.get('t') ?? ''
  const ticket = tickets.get(token)
  tickets.delete(token)
  if (!ticket || ticket.expires < Date.now() || !deps) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return true
  }
  const current = deps
  wss.handleUpgrade(request, socket, head, (ws) => new VoiceSession(ws, current, ticket.opening))
  return true
}

// ------------------------------------------------------------------- speech out

/**
 * Cuts streamed text into what can be spoken: whole sentences, or a clause once it is long
 * enough. Word by word would sound choppy; the whole answer would make him slow.
 */
export class SentenceChunker {
  private buffer = ''

  constructor(private readonly emit: (sentence: string) => void) {}

  push(text: string): void {
    this.buffer += text
    for (;;) {
      const end = this.buffer.search(/[.!?](\s|$)/)
      const comma = this.buffer.length > 80 ? this.buffer.search(/[,;:]\s/) : -1
      const cut = end >= 0 && end + 1 < this.buffer.length ? end + 1 : comma >= 20 ? comma + 1 : -1
      if (cut < 0) return
      this.say(this.buffer.slice(0, cut))
      this.buffer = this.buffer.slice(cut)
    }
  }

  flush(): void {
    this.say(this.buffer)
    this.buffer = ''
  }

  private say(text: string): void {
    const sentence = text.replace(/\s+/g, ' ').trim()
    if (sentence) this.emit(sentence)
  }
}

const VOICE = process.env.JARVIS_CASCADE_VOICE?.trim() || 'nl-NL-MaartenNeural'

const escapeXml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

/** One sentence through Edge's neural voice: an MP3 the device decodes and plays. */
export async function speakSentence(text: string): Promise<Buffer> {
  const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts')
  const tts = new MsEdgeTTS()
  try {
    await tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
    const { audioStream } = tts.toStream(escapeXml(text), { rate: '+5%' })
    const chunks: Buffer[] = []
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Edge TTS gaf geen antwoord')), 10_000)
      audioStream.on('data', (chunk: Buffer) => chunks.push(chunk))
      audioStream.on('end', () => {
        clearTimeout(timer)
        resolve()
      })
      audioStream.on('error', (error: Error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
    return Buffer.concat(chunks)
  } finally {
    tts.close()
  }
}

/** Words that bridge a slow answer, made once and kept: no waiting for Edge on these. */
const FILLERS = ['Even kijken.', 'Momentje.', 'Eens zien.']
/** Off since 28 Sep 2026: Hidde heard "momentje" as talking over him (K6). Silence is fine. */
const FILLERS_ON = false
const FILLER_AFTER_MS = 1000
const fillers = new Map<string, Promise<Buffer | null>>()

export function fillerAudio(text: string): Promise<Buffer | null> {
  let made = fillers.get(text)
  if (!made) {
    made = speakSentence(text).catch(() => {
      fillers.delete(text)
      return null
    })
    fillers.set(text, made)
  }
  return made
}

/** Seconds of speech in an MP3 at 48 kbit/s: what the device will play. */
const mp3Seconds = (bytes: number): number => (bytes * 8) / 48_000

// -------------------------------------------------------------------- speech in

function wav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(SAMPLE_RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** What Hidde said, in Dutch. Batch for now; Deepgram Flux can stream it later, same place. */
export async function transcribe(pcm: Buffer, key: string): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(wav(pcm))], { type: 'audio/wav' }), 'zin.wav')
  form.append('model', 'gpt-4o-mini-transcribe')
  form.append('language', 'nl')
  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(15_000)
  })
  const body = (await response.json().catch(() => ({}))) as { text?: string; error?: { message?: string } }
  if (!response.ok) throw new Error(`Spraakherkenning ${response.status}: ${body.error?.message ?? 'onbekende fout'}`)
  return (body.text ?? '').trim()
}

/**
 * OpenAI's streaming transcription, fed while Hidde talks: the text is ready about 0.6 s
 * after he stops, where the batch call took 0.8 to 3 s (measured 28 Sep 2026). Our side
 * decides when the turn ends; this only listens. Anything wrong and finish() gives null,
 * so the batch call takes over.
 */
class LiveListener {
  private socket: WebSocket
  private ready: Promise<boolean>
  private waiting: ((text: string | null) => void) | null = null

  constructor(key: string) {
    this.socket = new WebSocketClient('wss://api.openai.com/v1/realtime?intent=transcription', { headers: { Authorization: `Bearer ${key}` } })
    this.ready = new Promise((resolve) => {
      this.socket.on('open', () => {
        this.socket.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              type: 'transcription',
              audio: {
                input: {
                  format: { type: 'audio/pcm', rate: SAMPLE_RATE },
                  transcription: { model: 'gpt-4o-mini-transcribe', language: 'nl' },
                  turn_detection: null
                }
              }
            }
          })
        )
        resolve(true)
      })
      this.socket.on('error', () => resolve(false))
    })
    this.socket.on('message', (data) => {
      let event: { type?: string; transcript?: string }
      try {
        event = JSON.parse(String(data)) as typeof event
      } catch {
        return
      }
      if (event.type === 'conversation.item.input_audio_transcription.completed') this.settle((event.transcript ?? '').trim())
      if (event.type === 'error') this.settle(null)
    })
    this.socket.on('close', () => this.settle(null))
  }

  private settle(text: string | null): void {
    const waiting = this.waiting
    this.waiting = null
    waiting?.(text)
  }

  private send(event: Record<string, unknown>): void {
    if (this.socket.readyState === this.socket.OPEN) this.socket.send(JSON.stringify(event))
  }

  append(pcm: Buffer): void {
    void this.ready.then((ok) => ok && this.send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') }))
  }

  /** Too short to be a question: forget it. */
  discard(): void {
    void this.ready.then((ok) => ok && this.send({ type: 'input_audio_buffer.clear' }))
  }

  async finish(): Promise<string | null> {
    if (!(await this.ready) || this.socket.readyState !== this.socket.OPEN) return null
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(null), 4000)
      this.waiting = (text) => {
        clearTimeout(timer)
        resolve(text)
      }
      this.send({ type: 'input_audio_buffer.commit' })
    })
  }

  close(): void {
    this.settle(null)
    try {
      this.socket.close()
    } catch {
      // Already closed.
    }
  }
}

/**
 * Deepgram Flux: hears Dutch and knows when Hidde is done, 50 to 300 ms after his last word
 * (measured 28 Sep 2026), with the words ready. That replaces waiting for a pause on the
 * device and transcribing afterwards, which took about 1.6 s together.
 */
class FluxListener {
  private ready: Promise<boolean>
  /** Audio streamed, in bytes: Flux bills by the minute of audio. */
  bytes = 0

  private socket!: WebSocket

  /**
   * `keyterms`: the words Hidde uses that a general model mishears (his task titles, "inplannen",
   * "Tessie"). On his phone Flux once heard "staan u niet in planeet" for "staat niet in de planning".
   */
  constructor(key: string, onTurn: (text: string) => void, keyterms: Promise<string[]>, onHearing?: (text: string) => void) {
    this.ready = keyterms
      .catch(() => [] as string[])
      .then(
        (terms) =>
          new Promise<boolean>((resolve) => {
            const query = new URLSearchParams({ model: 'flux-general-multi', language_hint: 'nl', encoding: 'linear16', sample_rate: String(SAMPLE_RATE), eot_threshold: '0.85' })
            for (const term of terms) query.append('keyterm', term)
            this.socket = new WebSocketClient(`wss://api.deepgram.com/v2/listen?${query}`, { headers: { Authorization: `Token ${key}` } })
            this.socket.on('open', () => resolve(true))
            this.socket.on('error', (error) => {
              log.warn('Jarvis cascade: Flux did not connect.', error)
              resolve(false)
            })
            this.listen(onTurn, onHearing)
          })
      )
  }

  private listen(onTurn: (text: string) => void, onHearing?: (text: string) => void): void {
    this.socket.on('message', (data) => {
      let event: { type?: string; event?: string; transcript?: string }
      try {
        event = JSON.parse(String(data)) as typeof event
      } catch {
        return
      }
      if (event.type === 'TurnInfo' && event.event === 'EndOfTurn') onTurn((event.transcript ?? '').trim())
      // What he is saying, while he says it: the screen shows it live.
      else if (event.type === 'TurnInfo' && event.transcript) onHearing?.(event.transcript.trim())
    })
  }

  append(pcm: Buffer): void {
    this.bytes += pcm.length
    void this.ready.then((ok) => ok && this.socket.readyState === this.socket.OPEN && this.socket.send(pcm))
  }

  close(): void {
    try {
      void this.ready.then(() => this.socket?.close())
    } catch {
      // Already closed.
    }
  }
}

/** Words he says that a speech model should expect: fixed ones and his open tasks' titles. */
const FIXED_TERMS = ['Jarvis', 'inplannen', 'planning', 'afvinken', 'agenda', 'afspraak', 'stage', 'Tessie', 'Zevenaar', 'Nieuwendijk']

export async function keytermsFor(api: TimeTrackerAPI): Promise<string[]> {
  const titles = (await api.tasks.list({ status: 'active' })).map((task) => task.title.trim()).filter((title) => title.length >= 3 && title.length <= 40)
  // Deepgram takes up to a hundred; the most recent tasks are the likeliest to be named.
  return [...new Set([...FIXED_TERMS, ...titles])].slice(0, 80)
}

/** Flux multilingual, per minute of streamed audio. */
const FLUX_PER_MINUTE = 0.47 / 60

// ---------------------------------------------------------------------- session

interface Spoken {
  text: string
  seconds: number
}

class VoiceSession {
  private readonly brain: Brain
  private readonly parts: ReturnType<typeof instructionParts>
  private utterance: Buffer[] = []
  /** Transcribes while he talks, so the words are there the moment he stops. */
  private listener: LiveListener | null = null
  /** Deepgram Flux, when there is a key: hears the end of his turn itself. */
  private flux: FluxListener | null = null
  /** Flux handed this utterance over already; the gate closing after it changes nothing. */
  private fluxHandled = false
  /** After the old way took a sentence, a late Flux turn for it is ignored until then. */
  private ignoreFluxUntil = 0
  /** Tools of the running turn, for the log. */
  private toolNames: string[] = []
  /** Tools of the running turn with their results, for the record of this talk. */
  private toolCalls: TurnRecord['tools'] = []
  /** This conversation, turn by turn; and the one it carried on from. */
  private readonly id = randomUUID()
  private turns: TurnRecord[] = []
  private previous: { id: string; turns: TurnRecord[] } | null = null
  private lastComplaint: { number: string; at: number } | null = null
  private fillers = 0
  /** The turn that may still speak; older ones finish quietly. */
  private turn = 0
  private spoken: Spoken[] = []
  private speech: Promise<void> = Promise.resolve()
  private tools = new Map<string, (result: unknown) => void>()
  private toolCount = 0
  private closed = false
  private spent = 0

  constructor(
    private readonly ws: WebSocket,
    private readonly deps: VoiceDeps,
    opening: string | null
  ) {
    const key = deps.secret('geminiKey')
    if (!key) throw new Error('Geen geminiKey op de server.')
    this.parts = instructionParts({ api: deps.api, system: deps.system, opening })
    const carriedOn = recent && recent.day === dayKey() && Date.now() - recent.endedAt < CARRY_ON_MS ? recent : null
    this.previous = carriedOn
    const carried = carriedOn?.history
    this.brain = new Brain({
      key,
      model: process.env.JARVIS_CASCADE_MODEL?.trim() || 'gemini-3.8-flash',
      thinking: 'low',
      fixed: this.parts.fixed,
      history: carried
    })

    talking.set(this, Date.now())
    ws.on('message', (data, isBinary) => {
      talking.set(this, Date.now())
      if (isBinary) {
        const pcm = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
        this.utterance.push(pcm)
        this.listener?.append(pcm)
        this.flux?.append(pcm)
      }
      else void this.control(String(data))
    })
    ws.on('close', () => void this.close())
    ws.on('error', () => void this.close())

    const deepgramKey = deps.secret('deepgramKey')
    const openaiKey = deps.secret('openaiKey')
    if (deepgramKey) {
      this.flux = new FluxListener(deepgramKey, (text) => this.fluxTurn(text), keytermsFor(deps.api), (text) => this.send({ type: 'hearing', text }))
    }
    else if (openaiKey) this.listener = new LiveListener(openaiKey)
    for (const text of FILLERS) void fillerAudio(text)
    // The cache is made while he is still saying hello, not while he waits for an answer.
    void this.brain.warm().catch((error: unknown) => log.warn('Jarvis cascade: cache failed.', error))
    if (opening) void this.answer(opening)
  }

  private send(message: Record<string, unknown>): void {
    if (!this.closed && this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(message))
  }

  private async control(raw: string): Promise<void> {
    let message: { type?: string; text?: string; ms?: number; id?: string; result?: unknown }
    try {
      message = JSON.parse(raw) as typeof message
    } catch {
      return
    }
    switch (message.type) {
      case 'end':
        return this.heard()
      case 'text':
        if (message.text?.trim() && this.command(message.text)) return
        if (message.text?.trim()) return this.answer(message.text.trim())
        return
      case 'cutoff':
        return this.cutOff(Number(message.ms) || 0)
      case 'tool_result':
        this.tools.get(String(message.id))?.(message.result)
        this.tools.delete(String(message.id))
        return
    }
  }

  /** He stopped talking: what did he say? */
  /** Flux heard the end of his turn, with the words: straight to the answer. */
  private fluxTurn(text: string): void {
    this.utterance = []
    // The old way already took this sentence (Flux was late): once is enough.
    if (Date.now() < this.ignoreFluxUntil) return
    this.fluxHandled = true
    if (!text.trim()) return
    this.send({ type: 'heard', text })
    if (this.command(text)) return
    void this.answer(text)
  }

  /**
   * A command the device carries out without an answer: "5 sec" starts the countdown, and
   * Jarvis says nothing (the language model never sees it). True when it was one.
   */
  private command(text: string): boolean {
    if (!isSprintCommand(text)) return false
    this.send({ type: 'command', name: 'sprint' })
    return true
  }

  /**
   * The device's gate closed. With Flux that is usually after Flux already handed the turn
   * over; then there is nothing left to do. If Flux has not (yet), give it a moment, and
   * then transcribe what came in the old way.
   */
  private async heard(): Promise<void> {
    if (this.flux) {
      for (let waited = 0; !this.fluxHandled && waited < 800; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50))
      if (this.fluxHandled) {
        this.fluxHandled = false
        this.utterance = []
        return
      }
      log.warn('Jarvis cascade: Flux gave no end of turn; transcribing the old way.')
      this.ignoreFluxUntil = Date.now() + 5000
    }
    const pcm = Buffer.concat(this.utterance)
    this.utterance = []
    if (pcm.length < SAMPLE_RATE * 2 * MIN_SPEECH_S) {
      this.listener?.discard()
      return
    }
    const key = this.deps.secret('openaiKey')
    if (!key) return this.send({ type: 'error', message: 'Geen openaiKey voor spraakherkenning op de server.' })
    let text: string | null = null
    // The live listener has heard it all already; the batch call is the fallback.
    if (this.listener) text = await this.listener.finish().catch(() => null)
    if (text === null) {
      try {
        text = await transcribe(pcm, key)
      } catch (error) {
        log.warn('Jarvis cascade: transcription failed.', error)
        return this.send({ type: 'error', message: 'Ik verstond je niet goed, zeg het nog eens?' })
      }
    }
    this.spent += (pcm.length / (SAMPLE_RATE * 2) / 60) * STT_PER_MINUTE
    if (!text) return
    this.send({ type: 'heard', text })
    if (this.command(text)) return
    await this.answer(text)
  }

  /** Runs a tool on the device and waits for its answer. */
  private callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name === 'report_problem') {
      const result = this.complain(args)
      this.toolCalls.push({ name, args, result: JSON.stringify(result) })
      return Promise.resolve(result)
    }
    return this.deviceTool(name, args).then((result) => {
      this.toolCalls.push({ name, args, result: JSON.stringify(result).slice(0, 600) })
      return result
    })
  }

  /** A complaint, kept with this conversation and the one just before it. */
  private complain(args: Record<string, unknown>): Record<string, unknown> {
    // The model sometimes calls it again in the next round of the same answer: once is enough.
    if (this.lastComplaint && Date.now() - this.lastComplaint.at < 60_000) {
      return { saved: true, number: this.lastComplaint.number, next: `Al vastgelegd als ${this.lastComplaint.number}. Zeg dat kort, één keer.` }
    }
    const number = saveComplaint(this.deps.usagePath, {
      at: new Date().toISOString(),
      complaint: String(args.complaint ?? ''),
      whatWentWrong: args.whatWentWrong ? String(args.whatWentWrong) : null,
      conversation: this.id,
      turns: this.turns,
      previous: this.previous ? { conversation: this.previous.id, turns: this.previous.turns } : null
    })
    this.lastComplaint = { number, at: Date.now() }
    log.info('Jarvis complaint.', { number, complaint: args.complaint })
    return { saved: true, number, next: `Vastgelegd als ${number}. Zeg dat kort, met het nummer.` }
  }

  private deviceTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const id = `c${++this.toolCount}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.tools.delete(id)
        resolve({ error: 'Het apparaat gaf geen antwoord op de tool.' })
      }, TOOL_TIMEOUT_MS)
      this.tools.set(id, (result) => {
        clearTimeout(timer)
        resolve(result)
      })
      this.toolNames.push(name)
      this.send({ type: 'tool_call', id, name, args })
    })
  }

  /**
   * One sentence into the speech queue: made right away (Edge needs most of a second before
   * the first byte, so sentences are made side by side), sent in order.
   */
  private sayFiller(turn: number): void {
    const text = FILLERS[this.fillers++ % FILLERS.length]!
    this.say(turn, text, fillerAudio(text))
  }

  private say(turn: number, sentence: string, ready?: Promise<Buffer | null>): void {
    const made =
      ready ??
      speakSentence(sentence).catch((error: unknown) => {
        log.warn('Jarvis cascade: speech failed.', error)
        return null
      })
    this.speech = this.speech.then(async () => {
      if (turn !== this.turn || this.closed) return
      try {
        const mp3 = await made
        if (!mp3 || turn !== this.turn) return
        this.spoken.push({ text: sentence, seconds: mp3Seconds(mp3.length) })
        this.send({ type: 'audio_mp3', data: mp3.toString('base64') })
      } catch (error) {
        log.warn('Jarvis cascade: speech failed.', error)
      }
    })
  }

  private async answer(text: string): Promise<void> {
    const turn = ++this.turn
    this.spoken = []
    this.send({ type: 'reply_start' })
    const chunker = new SentenceChunker((sentence) => this.say(turn, sentence))
    let saidSomething = false
    let cutText: string | null = null
    // No words after a second: a short "momentje" in his voice, so silence never feels broken.
    // At most one per turn; the tool rounds use the same one.
    const filler = (): void => {
      if (!FILLERS_ON || saidSomething || turn !== this.turn) return
      saidSomething = true
      this.sayFiller(turn)
    }
    const fillerTimer = setTimeout(filler, FILLER_AFTER_MS)
    try {
      const stateStarted = Date.now()
      const state = await this.parts.state()
      this.send({ type: 'timing', state: Date.now() - stateStarted })
      const result = await this.brain.turn(
        text,
        state,
        async (name, args) => {
          // A tool round takes a second or two more: cover it now rather than after the timer.
          filler()
          return this.callTool(name, args)
        },
        (delta) => {
          if (turn !== this.turn) return
          clearTimeout(fillerTimer)
          saidSomething = true
          this.send({ type: 'reply_text', delta })
          chunker.push(delta)
        }
      )
      this.spent += result.usd
      // The whole exchange, so a conversation can be read back when something went wrong.
      log.info('Jarvis cascade turn.', { heard: text, reply: result.text, tools: this.toolNames, cut: turn !== this.turn })
      this.turns.push({ at: new Date().toISOString(), heard: text, reply: result.text, tools: this.toolCalls, cut: turn !== this.turn })
      this.toolCalls = []
      this.toolNames = []
      if (turn === this.turn) {
        chunker.flush()
        await this.speech
        this.send({ type: 'turn_done' })
      } else {
        cutText = this.heardSoFar
      }
    } catch (error) {
      log.warn('Jarvis cascade: turn failed.', error)
      if (turn === this.turn) this.send({ type: 'error', message: 'Er ging iets mis, probeer het nog eens.' })
    } finally {
      clearTimeout(fillerTimer)
    }
    // Cut off: the history keeps only what he got to hear.
    if (cutText !== null) this.brain.cutOff(cutText)
  }

  /** Set by cutOff: the part of the answer that was heard. */
  private heardSoFar = ''

  private cutOff(ms: number): void {
    let left = ms / 1000
    const heard: string[] = []
    for (const sentence of this.spoken) {
      if (left <= 0) break
      heard.push(sentence.text)
      left -= sentence.seconds
    }
    this.heardSoFar = heard.join(' ')
    // Everything still queued or thinking for the old turn falls silent.
    this.turn += 1
  }

  private async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    talking.delete(this)
    for (const resolve of this.tools.values()) resolve({ error: 'Het gesprek is gesloten.' })
    this.tools.clear()
    recent = { history: this.brain.conversation, endedAt: Date.now(), day: dayKey(), id: this.id, turns: this.turns }
    this.listener?.close()
    this.flux?.close()
    if (this.flux) this.spent += (this.flux.bytes / (SAMPLE_RATE * 2) / 60) * FLUX_PER_MINUTE
    await this.brain.close().catch(() => undefined)
    if (this.spent > 0) {
      const spend = addCostUsd(this.deps.usagePath, this.spent)
      log.info('Jarvis cascade spend.', { usd: Math.round(this.spent * 10_000) / 10_000, month: spend.usd })
    }
  }
}
