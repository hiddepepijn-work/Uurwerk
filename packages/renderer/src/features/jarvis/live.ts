import { GoogleGenAI, type LiveServerMessage, type ModalityTokenCount, type Session } from '@google/genai'
import type { MutableRefObject } from 'react'

import type { JarvisLiveSession, JarvisLiveUsage } from '@core/contract/api.js'

import { api } from '../../api/client.js'
import { SpeechGate } from './gate.js'
import type { OrbState } from './JarvisOrb.js'

/**
 * A live conversation with Jarvis: the microphone streams to the realtime model (Gemini Live
 * or OpenAI Realtime, whichever the server hands a token for), his voice streams back and
 * plays as it arrives, and either side can cut in. The server hands out the token (with the
 * brief, the tools and today's day locked in); the tools run here, on this copy.
 *
 * The conversation is the same for both; only the wire differs (GeminiWire, OpenAIWire).
 *
 * The microphone only streams while someone is actually talking: silence is not sent, and
 * so not paid for. A short pre-roll keeps the first syllable.
 */

export interface LiveHandlers {
  onPhase(phase: OrbState): void
  /** What Hidde is saying, as it is recognised. */
  onHeard(text: string): void
  /** What Jarvis is saying, as he says it. */
  onReply(text: string): void
  /** The conversation ended by itself: a problem, or the connection closed. */
  onEnd(problem: string | null): void
  /** A tool ran: the laptop's corner shows what a confirm changed. */
  onToolResult?(name: string, result: unknown): void
}

/** Both models take 24 kHz (Gemini resamples); the context is made before the token is in. */
const MIC_RATE = 24_000
const VOICE_RATE = 24_000
/** Samples per chunk sent: 40 ms. */
const CHUNK = 960
/** Audio kept from before the gate opened, so the first syllable is not lost. */
const PREROLL_CHUNKS = 8

/** Runs off the main thread: mono float in, 40 ms of 16-bit PCM plus its loudness out. */
const WORKLET = `
class Capture extends AudioWorkletProcessor {
  // A quiet microphone (a laptop's built-in array) is brought up to speaking level: the
  // gain follows the loudness of the last seconds, at most fourfold.
  constructor() { super(); this.buffer = new Int16Array(${CHUNK}); this.fill = 0; this.sum = 0; this.level = 0.03; this.gain = 1 }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    let block = 0
    for (let i = 0; i < channel.length; i++) block += channel[i] * channel[i]
    const blockRms = Math.sqrt(block / channel.length)
    if (blockRms > 0.004) this.level = this.level * 0.995 + blockRms * 0.005
    this.gain = Math.min(4, Math.max(1, 0.05 / Math.max(this.level, 0.0125)))
    for (let i = 0; i < channel.length; i++) {
      const sample = Math.max(-1, Math.min(1, channel[i] * this.gain))
      this.buffer[this.fill++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
      this.sum += sample * sample
      if (this.fill === ${CHUNK}) {
        this.port.postMessage({ pcm: this.buffer.buffer, rms: Math.sqrt(this.sum / ${CHUNK}) }, [this.buffer.buffer])
        this.buffer = new Int16Array(${CHUNK}); this.fill = 0; this.sum = 0
      }
    }
    return true
  }
}
registerProcessor('uurwerk-capture', Capture)
`

const EMPTY: JarvisLiveUsage = { textIn: 0, audioIn: 0, textOut: 0, audioOut: 0, thoughts: 0 }
const COUNTS = ['textIn', 'audioIn', 'textOut', 'audioOut', 'thoughts', 'textInCached', 'audioInCached'] as const

/** Splits a total by modality; without details, all of it counts as the dearer audio. */
function split(total: number | undefined, details: ModalityTokenCount[] | undefined): { text: number; audio: number } {
  if (!details?.length) return { text: 0, audio: total ?? 0 }
  let text = 0
  let audio = 0
  for (const entry of details) {
    if (String(entry.modality) === 'TEXT') text += entry.tokenCount ?? 0
    else audio += entry.tokenCount ?? 0
  }
  return { text, audio }
}

const add = (into: JarvisLiveUsage, more: JarvisLiveUsage): void => {
  for (const kind of COUNTS) into[kind] = (into[kind] ?? 0) + (more[kind] ?? 0)
}

/** Jarvis's trail in the app log (the main process forwards "[jarvis]" lines). */
const trail = (message: string): void => console.info(`[jarvis] ${message}`)

const toBase64 = (bytes: ArrayBuffer): string => {
  let binary = ''
  const view = new Uint8Array(bytes)
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000))
  return btoa(binary)
}

const fromBase64 = (data: string): Int16Array => {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Int16Array(bytes.buffer, 0, bytes.length >> 1)
}

// ---------------------------------------------------------------- wires

interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

/** What a wire reports; the conversation (LiveCall) decides what it means. */
interface WireEvents {
  heard(delta: string): void
  /** Hidde started talking over Jarvis. */
  interrupted(): void
  /** A new answer starts. */
  replyStart(): void
  audio(base64: string): void
  replyText(delta: string): void
  /** An answer is done; `working`: he is still on it (tools running, or "even kijken"). */
  turnDone(working: boolean): void
  usage(usage: JarvisLiveUsage): void
  tools(calls: ToolCall[]): Promise<Array<{ call: ToolCall; result: Record<string, unknown> }>>
  closed(code: number, reason: string): void
}

interface Wire {
  audio(pcm: ArrayBuffer): void
  /** The gate closed: the microphone paused. */
  paused(): void
  /** A typed line, as Hidde's turn. */
  text(text: string): void
  /** Jarvis was cut off after this many ms of his current answer had played. */
  cutOff(playedMs: number): void
  close(): void
}

/** Gemini Live, through its SDK. */
class GeminiWire implements Wire {
  private session: Session | null = null
  private turnUsage: JarvisLiveUsage | null = null
  private replying = false
  /** Gemini's latest resumption handle: a dropped connection carries on from it. */
  handle: string | null = null

  static async open(live: JarvisLiveSession, events: WireEvents): Promise<GeminiWire> {
    const wire = new GeminiWire()
    const ai = new GoogleGenAI({ apiKey: live.token, httpOptions: { apiVersion: live.apiVersion } })
    wire.session = await ai.live.connect({
      model: live.model,
      config: live.config,
      callbacks: {
        onmessage: (message) => void wire.receive(message, events),
        onerror: (event) => trail(`verbindingsfout: ${event.message}`),
        onclose: (event) => events.closed(event.code, event.reason)
      }
    })
    return wire
  }

  private async receive(message: LiveServerMessage, events: WireEvents): Promise<void> {
    const update = message.sessionResumptionUpdate
    if (update?.resumable && update.newHandle) this.handle = update.newHandle
    if (message.goAway) trail(`Google sluit de verbinding zo (nog ${String(message.goAway.timeLeft ?? '?')}); ik ga daarna verder`)
    const content = message.serverContent

    if (content?.inputTranscription?.text) events.heard(content.inputTranscription.text)
    if (content?.interrupted) events.interrupted()
    const start = (): void => {
      if (this.replying) return
      this.replying = true
      events.replyStart()
    }
    if (content?.modelTurn?.parts) {
      start()
      for (const part of content.modelTurn.parts) if (part.inlineData?.data) events.audio(part.inlineData.data)
    }
    if (content?.outputTranscription?.text) {
      start()
      events.replyText(content.outputTranscription.text)
    }
    if (message.usageMetadata) {
      const meta = message.usageMetadata
      const input = split(meta.promptTokenCount, meta.promptTokensDetails)
      const output = split(meta.responseTokenCount, meta.responseTokensDetails)
      this.turnUsage = {
        textIn: input.text,
        audioIn: input.audio,
        textOut: output.text,
        audioOut: output.audio,
        thoughts: meta.thoughtsTokenCount ?? 0
      }
    }
    if (content?.turnComplete) {
      this.replying = false
      if (this.turnUsage) events.usage(this.turnUsage)
      this.turnUsage = null
      events.turnDone(String(content.interactionStatus) === 'IN_PROGRESS')
    }
    if (message.toolCall?.functionCalls?.length) {
      const calls = message.toolCall.functionCalls.map((call) => ({
        id: call.id ?? '',
        name: call.name ?? '',
        args: (call.args ?? {}) as Record<string, unknown>
      }))
      const results = await events.tools(calls)
      // No scheduling: 3.8 Live refuses it (and closes), and answers on its own.
      this.session?.sendToolResponse({
        functionResponses: results.map(({ call, result }) => ({ id: call.id, name: call.name, response: result }))
      })
    }
  }

  audio(pcm: ArrayBuffer): void {
    this.session?.sendRealtimeInput({ audio: { data: toBase64(pcm), mimeType: `audio/pcm;rate=${MIC_RATE}` } })
  }

  paused(): void {
    // Tells the model the microphone paused, so it answers instead of waiting.
    this.session?.sendRealtimeInput({ audioStreamEnd: true })
  }

  text(text: string): void {
    this.session?.sendClientContent({ turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true })
  }

  cutOff(): void {
    // Gemini keeps track of what was heard itself.
  }

  close(): void {
    try {
      this.session?.close()
    } catch {
      // Already closed.
    }
  }
}

interface OpenAIUsage {
  input_token_details?: {
    text_tokens?: number
    audio_tokens?: number
    cached_tokens_details?: { text_tokens?: number; audio_tokens?: number }
  }
  output_token_details?: { text_tokens?: number; audio_tokens?: number }
}

interface OpenAIEvent {
  type: string
  delta?: string
  item_id?: string
  error?: { message?: string; code?: string }
  response?: {
    status?: string
    output?: Array<{ type: string; call_id?: string; name?: string; arguments?: string }>
    usage?: OpenAIUsage
  }
}

/** OpenAI Realtime, over its WebSocket; the client secret goes in as a subprotocol. */
class OpenAIWire implements Wire {
  private socket: WebSocket | null = null
  /** The answer that is playing, for cutting it off where Hidde stopped hearing it. */
  private replyItem: string | null = null

  static open(live: JarvisLiveSession, events: WireEvents): Promise<OpenAIWire> {
    const wire = new OpenAIWire()
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(live.model)}`, [
        'realtime',
        `openai-insecure-api-key.${live.token}`
      ])
      wire.socket = socket
      let open = false
      socket.onopen = () => {
        open = true
        resolve(wire)
      }
      socket.onerror = () => {
        trail('verbindingsfout (OpenAI)')
        if (!open) reject(new Error('Kon geen verbinding maken met OpenAI.'))
      }
      socket.onclose = (event) => {
        if (open) events.closed(event.code, event.reason)
        else reject(new Error(`OpenAI weigerde de verbinding: ${event.code} ${event.reason}`))
      }
      socket.onmessage = (message: MessageEvent<string>) => {
        let event: OpenAIEvent
        try {
          event = JSON.parse(message.data) as OpenAIEvent
        } catch {
          return
        }
        void wire.receive(event, events)
      }
    })
  }

  private send(event: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(event))
  }

  private async receive(event: OpenAIEvent, events: WireEvents): Promise<void> {
    switch (event.type) {
      case 'input_audio_buffer.speech_started':
        events.interrupted()
        break
      case 'conversation.item.input_audio_transcription.delta':
        if (event.delta) events.heard(event.delta)
        break
      case 'response.created':
        this.replyItem = null
        events.replyStart()
        break
      case 'response.output_audio.delta':
        if (event.item_id) this.replyItem = event.item_id
        if (event.delta) events.audio(event.delta)
        break
      case 'response.output_audio_transcript.delta':
        if (event.delta) events.replyText(event.delta)
        break
      case 'error':
        // Cutting off an answer that had already ended is harmless.
        if (event.error?.code !== 'response_cancel_not_active') trail(`OpenAI-fout: ${event.error?.message ?? '?'}`)
        break
      case 'response.done': {
        const response = event.response
        if (response?.usage) {
          const input = response.usage.input_token_details ?? {}
          const output = response.usage.output_token_details ?? {}
          events.usage({
            provider: 'openai',
            textIn: input.text_tokens ?? 0,
            audioIn: input.audio_tokens ?? 0,
            textInCached: input.cached_tokens_details?.text_tokens ?? 0,
            audioInCached: input.cached_tokens_details?.audio_tokens ?? 0,
            textOut: output.text_tokens ?? 0,
            audioOut: output.audio_tokens ?? 0,
            thoughts: 0
          })
        }
        const calls = (response?.output ?? [])
          .filter((item) => item.type === 'function_call' && item.call_id && item.name)
          .map((item) => {
            let args: Record<string, unknown> = {}
            try {
              args = JSON.parse(item.arguments || '{}') as Record<string, unknown>
            } catch {
              // Left empty; the tool says what is missing.
            }
            return { id: item.call_id!, name: item.name!, args }
          })
        events.turnDone(calls.length > 0)
        if (calls.length > 0) {
          const results = await events.tools(calls)
          for (const { call, result } of results) {
            this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call.id, output: JSON.stringify(result) } })
          }
          // Unlike Gemini, OpenAI waits to be asked for the answer that uses the results.
          this.send({ type: 'response.create' })
        }
        break
      }
    }
  }

  audio(pcm: ArrayBuffer): void {
    this.send({ type: 'input_audio_buffer.append', audio: toBase64(pcm) })
  }

  paused(): void {
    // The server's turn detection hears the silence the gate still sends.
  }

  text(text: string): void {
    this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
    this.send({ type: 'response.create' })
  }

  cutOff(playedMs: number): void {
    // What he did not get to say is dropped from the conversation too, so he knows.
    if (!this.replyItem) return
    this.send({ type: 'response.cancel' })
    this.send({ type: 'conversation.item.truncate', item_id: this.replyItem, content_index: 0, audio_end_ms: Math.max(0, Math.round(playedMs)) })
    this.replyItem = null
  }

  close(): void {
    try {
      this.socket?.close(1000)
    } catch {
      // Already closed.
    }
  }
}

// ------------------------------------------------------------- the call

export class LiveCall {
  private wire: GeminiWire | OpenAIWire | null = null
  private micContext: AudioContext | null = null
  private voiceContext: AudioContext | null = null
  private stream: MediaStream | null = null
  private analyser: AnalyserNode | null = null
  private playing = new Set<AudioBufferSourceNode>()
  private playUntil = 0
  /** When the current answer's first audio was scheduled to play, in context time. */
  private replyStartedAt: number | null = null
  private preroll: ArrayBuffer[] = []
  private gate = new SpeechGate()
  private micLevel = 0
  private phase: OrbState = 'idle'
  private heard = ''
  private reply = ''
  private replyDone = true
  /** Jarvis said "even kijken" or runs tools, and is still working on the answer. */
  private working = false
  /** Tapped away: drop the rest of this answer. */
  private muted = false
  private usage: JarvisLiveUsage = { ...EMPTY }
  private frame = 0
  private closed = false
  /** How often a dropped connection was picked up (Gemini only: it hands out handles). */
  private resumes = 0
  /** For the trail: loudest the microphone got since the last report, chunks sent. */
  private loudest = 0
  private sentChunks = 0
  private lastReport = 0

  private constructor(
    private readonly level: MutableRefObject<number>,
    private readonly handlers: LiveHandlers
  ) {}

  static async start(
    moment: 'morning' | 'evening' | null,
    level: MutableRefObject<number>,
    handlers: LiveHandlers
  ): Promise<LiveCall> {
    const call = new LiveCall(level, handlers)
    try {
      await call.open(moment)
    } catch (error) {
      await call.teardown()
      throw error
    }
    return call
  }

  private setPhase(phase: OrbState): void {
    if (this.phase === phase) return
    this.phase = phase
    this.handlers.onPhase(phase)
  }

  private async open(moment: 'morning' | 'evening' | null): Promise<void> {
    // In the car holder the screen must stay on: iOS pauses the call when it locks.
    void window.audioFocus?.keepAwake?.({ on: true }).catch(() => undefined)
    // Audio first, while the tap that opened this still counts as a gesture.
    this.micContext = new AudioContext({ sampleRate: MIC_RATE })
    this.voiceContext = new AudioContext()
    this.analyser = this.voiceContext.createAnalyser()
    this.analyser.fftSize = 512
    this.analyser.connect(this.voiceContext.destination)
    void this.micContext.resume()
    void this.voiceContext.resume()
    this.setPhase('thinking')

    const [live, stream] = await Promise.all([
      api.jarvis.liveSession({ moment }),
      navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
      })
    ])
    this.stream = stream
    const track = stream.getAudioTracks()[0]
    // A microphone muted by the system (Windows, a mute key) delivers silence: say so,
    // rather than listening to nothing.
    if (track?.muted) {
      trail(`microfoon "${track.label}" staat gedempt`)
      throw new Error('Je microfoon staat gedempt (in Windows of met de mute-toets). Zet hem aan en probeer het opnieuw.')
    }
    trail(`token voor ${live.provider} ${live.model}; microfoon "${track?.label ?? '?'}" (${track?.readyState}), opname ${this.micContext.sampleRate} Hz ${this.micContext.state}`)

    await this.connect(live)

    const worklet = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
    await this.micContext.audioWorklet.addModule(worklet)
    URL.revokeObjectURL(worklet)
    const source = this.micContext.createMediaStreamSource(stream)
    const capture = new AudioWorkletNode(this.micContext, 'uurwerk-capture')
    capture.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) =>
      this.hear(event.data.pcm, event.data.rms)
    source.connect(capture)

    trail('verbonden, luistert')
    this.animate()
    this.usage.provider = live.provider
    if (live.opening) {
      this.wire?.text(live.opening)
    } else {
      this.setPhase('listening')
    }
  }

  /** Opens the connection the server's token is for. */
  private async connect(live: JarvisLiveSession): Promise<void> {
    let wire: GeminiWire | OpenAIWire | null = null
    const events: WireEvents = {
      heard: (delta) => {
        this.heard += delta
        this.handlers.onHeard(this.heard.trim())
      },
      interrupted: () => {
        // Hidde started talking: stop Jarvis mid-sentence.
        if (this.playing.size > 0) this.cutOff()
        this.setPhase('listening')
      },
      replyStart: () => {
        this.reply = ''
        this.replyDone = false
        this.replyStartedAt = null
      },
      audio: (data) => {
        if (!this.muted) this.play(data)
      },
      replyText: (delta) => {
        if (this.muted) return
        this.reply += delta
        this.handlers.onReply(this.reply.trim())
      },
      turnDone: (working) => {
        trail(`beurt klaar${working ? ' (werkt nog)' : ''}: "${this.reply.trim().slice(0, 80)}"`)
        this.working = working
        this.replyDone = true
        this.muted = false
      },
      usage: (usage) => add(this.usage, usage),
      tools: async (calls) => {
        trail(`tools: ${calls.map((call) => call.name).join(', ')}`)
        this.setPhase('thinking')
        return Promise.all(
          calls.map(async (call) => {
            try {
              const result = await api.jarvis.runTool({ name: call.name, args: call.args })
              this.handlers.onToolResult?.(call.name, result)
              return { call, result: { result } as Record<string, unknown> }
            } catch (error) {
              return { call, result: { error: error instanceof Error ? error.message : String(error) } }
            }
          })
        )
      },
      closed: (code, reason) => {
        // A connection replaced by a resumed one closes quietly.
        if (wire !== null && this.wire !== wire) return
        trail(`verbinding dicht door ${this.closed ? 'de app' : live.provider}: ${code} ${reason}`)
        if (this.closed) return
        void this.resumeOrFinish(code === 1000 ? null : reason || 'De verbinding met Jarvis is gesloten.')
      }
    }
    wire = live.provider === 'openai' ? await OpenAIWire.open(live, events) : await GeminiWire.open(live, events)
    this.wire = wire
  }

  /**
   * The connection dropped while the conversation was going: carry on where it was, with
   * the resumption handle Gemini gave, instead of vanishing mid-sentence.
   */
  private async resumeOrFinish(problem: string | null): Promise<void> {
    if (this.closed) return
    const handle = this.wire instanceof GeminiWire ? this.wire.handle : null
    if (!handle || this.resumes >= 3) {
      this.finish(problem)
      return
    }
    this.resumes += 1
    trail(`ik ga verder waar we waren (poging ${this.resumes})`)
    try {
      await this.connect(await api.jarvis.liveSession({ moment: null, resume: handle, provider: 'gemini' }))
      trail('weer verbonden')
    } catch (error) {
      trail(`verder gaan lukt niet: ${error instanceof Error ? error.message : String(error)}`)
      this.finish(problem ?? 'De verbinding met Jarvis viel weg.')
    }
  }

  /** Someone is talking into the microphone right now. */
  get hearing(): boolean {
    return this.gate.isOpen
  }

  // ------------------------------------------------------------ microphone

  private hear(pcm: ArrayBuffer, rms: number): void {
    if (!this.wire || this.closed) return
    this.micLevel = rms
    const now = performance.now()
    this.loudest = Math.max(this.loudest, rms)
    if (now - this.lastReport > 10_000) {
      if (this.lastReport > 0 && !this.gate.isOpen) {
        trail(`microfoon: hardste ${this.loudest.toFixed(3)}, ${this.sentChunks} stukjes verstuurd`)
      }
      this.loudest = 0
      this.lastReport = now
    }
    // His own voice is in the air while it plays, and a little after: see gate.ts.
    const speaking = !!this.voiceContext && this.playUntil + 0.3 > this.voiceContext.currentTime
    const decision = this.gate.hear(rms, now, speaking)
    if (decision.opened) {
      trail(`je praat (${rms.toFixed(3)} boven ${decision.threshold.toFixed(3)}${speaking ? ', door Jarvis heen' : ''})`)
      for (const chunk of this.preroll) this.send(chunk)
      this.preroll = []
      if (this.phase !== 'speaking') {
        this.heard = ''
        this.setPhase('listening')
      }
    }
    if (decision.send) {
      this.send(pcm)
      if (decision.closed) {
        trail(`stil; verstuurd tot nu: ${this.sentChunks} stukjes, gehoord: "${this.heard.trim().slice(0, 80)}"`)
        this.wire.paused()
        if (this.phase === 'listening' && this.heard) this.setPhase('thinking')
      }
    } else {
      this.preroll.push(pcm)
      if (this.preroll.length > PREROLL_CHUNKS) this.preroll.shift()
    }
  }

  private send(pcm: ArrayBuffer): void {
    this.sentChunks += 1
    this.wire?.audio(pcm)
  }

  // --------------------------------------------------------------- voice

  private play(data: string): void {
    const context = this.voiceContext
    if (!context || !this.analyser) return
    const samples = fromBase64(data)
    const buffer = context.createBuffer(1, samples.length, VOICE_RATE)
    const channel = buffer.getChannelData(0)
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i]! / 0x8000
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(this.analyser)
    // A small lead on the first chunk absorbs network jitter.
    const at = Math.max(context.currentTime + 0.06, this.playUntil)
    if (this.replyStartedAt === null) this.replyStartedAt = at
    source.start(at)
    this.playUntil = at + buffer.duration
    this.playing.add(source)
    source.onended = () => this.playing.delete(source)
    this.setPhase('speaking')
  }

  /** Stops his voice, and tells the model how much of the answer was heard. */
  private cutOff(): void {
    const context = this.voiceContext
    const played = context && this.replyStartedAt !== null ? (context.currentTime - this.replyStartedAt) * 1000 : 0
    this.stopVoice()
    this.wire?.cutOff(played)
  }

  private stopVoice(): void {
    for (const source of this.playing) {
      try {
        source.stop()
      } catch {
        // Already ended.
      }
    }
    this.playing.clear()
    this.playUntil = 0
  }

  /** The orb's level, and the switch back to listening when his voice has run out. */
  private animate(): void {
    const samples = new Uint8Array(512)
    const tick = (): void => {
      if (this.closed) return
      const context = this.voiceContext
      const speaking = context && this.playUntil > context.currentTime
      if (speaking && this.analyser) {
        this.analyser.getByteTimeDomainData(samples)
        let sum = 0
        for (const sample of samples) sum += ((sample - 128) / 128) ** 2
        this.level.current = Math.min(1, Math.sqrt(sum / samples.length) * 4)
      } else {
        this.level.current = Math.min(1, this.micLevel * 8)
        if (this.phase === 'speaking' && this.replyDone) this.setPhase(this.working ? 'thinking' : 'listening')
      }
      this.frame = requestAnimationFrame(tick)
    }
    this.frame = requestAnimationFrame(tick)
  }

  // ------------------------------------------------------------- control

  /** Tap while he talks: silence him and listen. */
  interrupt(): void {
    this.cutOff()
    if (!this.replyDone) this.muted = true
    this.setPhase('listening')
  }

  /** Typed instead of spoken, in the same conversation. */
  say(text: string): void {
    this.heard = text
    this.wire?.text(text)
    this.setPhase('thinking')
  }

  private finish(problem: string | null): void {
    if (this.closed) return
    void this.teardown()
    this.handlers.onEnd(problem)
  }

  async end(): Promise<void> {
    await this.teardown()
  }

  private async teardown(): Promise<void> {
    if (this.closed) return
    this.closed = true
    void window.audioFocus?.keepAwake?.({ on: false }).catch(() => undefined)
    cancelAnimationFrame(this.frame)
    this.level.current = 0
    this.stopVoice()
    this.wire?.close()
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    await Promise.all([this.micContext?.close(), this.voiceContext?.close()].map((done) => done?.catch(() => undefined)))
    const used = COUNTS.reduce((sum, kind) => sum + (this.usage[kind] ?? 0), 0)
    if (used > 0) await api.jarvis.liveUsage(this.usage).catch(() => undefined)
  }
}
