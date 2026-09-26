import { GoogleGenAI, type LiveServerMessage, type ModalityTokenCount, type Session } from '@google/genai'
import type { MutableRefObject } from 'react'

import type { JarvisLiveUsage } from '@core/contract/api.js'

import { api } from '../../api/client.js'
import type { OrbState } from './JarvisOrb.js'

/**
 * A live conversation with Jarvis: the microphone streams to Gemini Live, his voice streams
 * back and plays as it arrives, and either side can cut in. The server hands out the token
 * (with the brief, the tools and today's day locked in); the tools run here, on this copy.
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
}

const MIC_RATE = 16_000
const VOICE_RATE = 24_000
/** Samples per chunk sent: 40 ms. */
const CHUNK = 640
/** Audio kept from before the gate opened, so the first syllable is not lost. */
const PREROLL_CHUNKS = 8
/** The gate stays open this long after the voice drops, so pauses mid-sentence pass. */
const HANGOVER_MS = 900

/** Runs off the main thread: 16 kHz mono float in, 40 ms of 16-bit PCM plus its loudness out. */
const WORKLET = `
class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new Int16Array(${CHUNK}); this.fill = 0; this.sum = 0 }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    for (let i = 0; i < channel.length; i++) {
      const sample = Math.max(-1, Math.min(1, channel[i]))
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
  for (const kind of Object.keys(into) as Array<keyof JarvisLiveUsage>) into[kind] += more[kind]
}

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

export class LiveCall {
  private session: Session | null = null
  private micContext: AudioContext | null = null
  private voiceContext: AudioContext | null = null
  private stream: MediaStream | null = null
  private analyser: AnalyserNode | null = null
  private playing = new Set<AudioBufferSourceNode>()
  private playUntil = 0
  private preroll: ArrayBuffer[] = []
  private gateOpen = false
  private lastVoice = 0
  private noise = 0.01
  private micLevel = 0
  private phase: OrbState = 'idle'
  private heard = ''
  private reply = ''
  private replyDone = true
  /** Tapped away: drop the rest of this answer. */
  private muted = false
  private usage: JarvisLiveUsage = { ...EMPTY }
  private turnUsage: JarvisLiveUsage | null = null
  private frame = 0
  private closed = false

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

    const ai = new GoogleGenAI({ apiKey: live.token, httpOptions: { apiVersion: live.apiVersion } })
    this.session = await ai.live.connect({
      model: live.model,
      config: live.config,
      callbacks: {
        onmessage: (message) => void this.receive(message),
        onerror: (event) => this.finish(event.message || 'De verbinding met Jarvis viel weg.'),
        onclose: (event) => this.finish(event.code === 1000 ? null : event.reason || 'De verbinding met Jarvis is gesloten.')
      }
    })

    const worklet = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
    await this.micContext.audioWorklet.addModule(worklet)
    URL.revokeObjectURL(worklet)
    const source = this.micContext.createMediaStreamSource(stream)
    const capture = new AudioWorkletNode(this.micContext, 'uurwerk-capture')
    capture.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) =>
      this.hear(event.data.pcm, event.data.rms)
    source.connect(capture)

    this.animate()
    if (live.opening) {
      this.session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: live.opening }] }], turnComplete: true })
    } else {
      this.setPhase('listening')
    }
  }

  // ------------------------------------------------------------ microphone

  private hear(pcm: ArrayBuffer, rms: number): void {
    if (!this.session || this.closed) return
    this.micLevel = rms
    const now = performance.now()
    // The noise floor follows the room slowly; speech is well above it.
    if (!this.gateOpen) this.noise = this.noise * 0.98 + Math.min(rms, 0.05) * 0.02
    const threshold = Math.max(0.012, this.noise * 3)
    const voiced = rms > threshold

    if (voiced) this.lastVoice = now
    if (!this.gateOpen && voiced) {
      this.gateOpen = true
      for (const chunk of this.preroll) this.send(chunk)
      this.preroll = []
      if (this.phase !== 'speaking') {
        this.heard = ''
        this.setPhase('listening')
      }
    }
    if (this.gateOpen) {
      this.send(pcm)
      if (now - this.lastVoice > HANGOVER_MS) {
        this.gateOpen = false
        // Tells the model the microphone paused, so it answers instead of waiting.
        this.session.sendRealtimeInput({ audioStreamEnd: true })
        if (this.phase === 'listening' && this.heard) this.setPhase('thinking')
      }
    } else {
      this.preroll.push(pcm)
      if (this.preroll.length > PREROLL_CHUNKS) this.preroll.shift()
    }
  }

  private send(pcm: ArrayBuffer): void {
    this.session?.sendRealtimeInput({ audio: { data: toBase64(pcm), mimeType: `audio/pcm;rate=${MIC_RATE}` } })
  }

  // --------------------------------------------------------------- model

  private async receive(message: LiveServerMessage): Promise<void> {
    if (this.closed) return
    const content = message.serverContent

    if (content?.inputTranscription?.text) {
      this.heard += content.inputTranscription.text
      this.handlers.onHeard(this.heard.trim())
    }
    if (content?.interrupted) {
      // Hidde started talking: stop Jarvis mid-sentence.
      this.stopVoice()
      this.setPhase('listening')
    }
    if (content?.modelTurn?.parts) {
      if (this.replyDone) {
        this.reply = ''
        this.replyDone = false
      }
      for (const part of content.modelTurn.parts) {
        if (part.inlineData?.data && !this.muted) this.play(part.inlineData.data)
      }
    }
    if (content?.outputTranscription?.text && !this.muted) {
      if (this.replyDone) {
        this.reply = ''
        this.replyDone = false
      }
      this.reply += content.outputTranscription.text
      this.handlers.onReply(this.reply.trim())
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
      this.replyDone = true
      this.muted = false
      if (this.turnUsage) add(this.usage, this.turnUsage)
      this.turnUsage = null
    }

    if (message.toolCall?.functionCalls?.length) {
      this.setPhase('thinking')
      const responses = await Promise.all(
        message.toolCall.functionCalls.map(async (call) => {
          try {
            const result = await api.jarvis.runTool({ name: call.name ?? '', args: (call.args ?? {}) as Record<string, unknown> })
            // Speak about the result as soon as it is in, rather than keeping it for later.
            return { id: call.id, name: call.name, response: { result }, scheduling: 'WHEN_IDLE' as never }
          } catch (error) {
            return { id: call.id, name: call.name, response: { error: error instanceof Error ? error.message : String(error) } }
          }
        })
      )
      if (!this.closed) this.session?.sendToolResponse({ functionResponses: responses })
    }
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
    source.start(at)
    this.playUntil = at + buffer.duration
    this.playing.add(source)
    source.onended = () => this.playing.delete(source)
    this.setPhase('speaking')
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
        if (this.phase === 'speaking' && this.replyDone) this.setPhase('listening')
      }
      this.frame = requestAnimationFrame(tick)
    }
    this.frame = requestAnimationFrame(tick)
  }

  // ------------------------------------------------------------- control

  /** Tap while he talks: silence him and listen. */
  interrupt(): void {
    this.stopVoice()
    if (!this.replyDone) this.muted = true
    this.setPhase('listening')
  }

  /** Typed instead of spoken, in the same conversation. */
  say(text: string): void {
    this.heard = text
    this.session?.sendClientContent({ turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true })
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
    cancelAnimationFrame(this.frame)
    this.level.current = 0
    this.stopVoice()
    try {
      this.session?.close()
    } catch {
      // Already closed.
    }
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    await Promise.all([this.micContext?.close(), this.voiceContext?.close()].map((done) => done?.catch(() => undefined)))
    // A turn cut off by closing still counts.
    if (this.turnUsage) add(this.usage, this.turnUsage)
    this.turnUsage = null
    const used = Object.values(this.usage).reduce((sum, value) => sum + value, 0)
    if (used > 0) await api.jarvis.liveUsage(this.usage).catch(() => undefined)
  }
}
