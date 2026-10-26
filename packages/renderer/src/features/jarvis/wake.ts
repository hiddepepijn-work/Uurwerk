import { api } from '../../api/client.js'

/**
 * The corner window's ear for "Hey Jarvis": the microphone at 16 kHz, in 80 ms chunks, sent
 * to the laptop app where the wake word models run (main/src/wakeword.ts). Nothing leaves
 * the machine. Paused while a conversation runs, so Jarvis saying his own name cannot call
 * him again.
 */

const RATE = 16_000
/** 80 ms: the step the wake word models move in. */
const CHUNK = 1280

const WORKLET = `
class WakeCapture extends AudioWorkletProcessor {
  // A quiet microphone is brought up to speaking level: the gain follows the loudness of
  // the last seconds, at most eightfold, so a laptop's built-in array is heard as a headset is.
  constructor() { super(); this.buffer = new Int16Array(${CHUNK}); this.fill = 0; this.level = 0.02; this.gain = 1 }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    let sum = 0
    for (let i = 0; i < channel.length; i++) sum += channel[i] * channel[i]
    const rms = Math.sqrt(sum / channel.length)
    if (rms > 0.002) this.level = this.level * 0.995 + rms * 0.005
    this.gain = Math.min(8, Math.max(1, 0.05 / Math.max(this.level, 0.004)))
    for (let i = 0; i < channel.length; i++) {
      const sample = Math.max(-1, Math.min(1, channel[i] * this.gain))
      this.buffer[this.fill++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
      if (this.fill === ${CHUNK}) {
        this.port.postMessage(this.buffer.buffer, [this.buffer.buffer])
        this.buffer = new Int16Array(${CHUNK}); this.fill = 0
      }
    }
    return true
  }
}
registerProcessor('uurwerk-wake-capture', WakeCapture)
`

/** No chunk for this long: the capture died (a device error, sleep, a headset unplugged). */
const SILENT_MS = 6000
const WATCH_MS = 2000

/**
 * Keeps itself alive. On 6 Oct 2026 the AudioContext hit "an error from the audio device"
 * (a headset switch or sleep) and the wake word stayed deaf for a week, because nothing
 * ever opened the microphone again. Now a watchdog does: no chunk for six seconds, a device
 * added or removed, the track ended, or the context in error — close it all and open anew.
 */
export class WakeWord {
  private listening = true
  private stopped = false
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private lastChunk = 0
  private healing: Promise<void> | null = null
  /** Failed reopenings in a row: logged once, not every two seconds. */
  private failures = 0
  private lastAttempt = 0
  private watchdog: ReturnType<typeof setInterval> | null = null
  private readonly deviceChanged = (): void => {
    // Let Windows settle on its new default first.
    setTimeout(() => this.heal('ander geluidsapparaat'), 1000)
  }

  private constructor() {}

  static async start(): Promise<WakeWord> {
    const wake = new WakeWord()
    await wake.open()
    wake.watchdog = setInterval(() => wake.check(), WATCH_MS)
    navigator.mediaDevices.addEventListener('devicechange', wake.deviceChanged)
    return wake
  }

  private async open(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      // No noise suppression: it takes the edges off exactly the sounds the wake word needs.
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true, channelCount: 1 }
    })
    const context = new AudioContext({ sampleRate: RATE })
    try {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
      await context.audioWorklet.addModule(url)
      URL.revokeObjectURL(url)
      const node = new AudioWorkletNode(context, 'uurwerk-wake-capture')
      node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (context !== this.context) return
        this.lastChunk = Date.now()
        if (this.listening) void api.window.wakeAudio(event.data).catch(() => undefined)
      }
      context.createMediaStreamSource(stream).connect(node)
      await context.resume()
    } catch (error) {
      for (const track of stream.getTracks()) track.stop()
      await context.close().catch(() => undefined)
      throw error
    }
    this.stream = stream
    this.context = context
    this.lastChunk = Date.now()
    const track = stream.getAudioTracks()[0]
    console.info(`[jarvis] wekwoord luistert via "${track?.label ?? '?'}" (${context.state}${track?.muted ? ', maar de microfoon staat GEDEMPT' : ''})`)
    // The system mute switched on or off while listening: say so in the log.
    track?.addEventListener('mute', () => console.info('[jarvis] microfoon gedempt; het wekwoord hoort nu niets'))
    track?.addEventListener('unmute', () => console.info('[jarvis] microfoon weer aan; het wekwoord luistert'))
    track?.addEventListener('ended', () => this.heal('microfoon weg'))
    ;(context as EventTarget).addEventListener('error', () => this.heal('fout in het geluidsapparaat'))
  }

  private check(): void {
    if (this.stopped || this.healing) return
    // Failing to open: wait longer each time, up to a minute.
    if (this.failures > 0 && Date.now() - this.lastAttempt < Math.min(60_000, WATCH_MS * 2 ** this.failures)) return
    if (Date.now() - this.lastChunk > SILENT_MS) this.heal('geen geluid meer binnen')
  }

  /** Closes the capture and opens a new one; a failure is tried again by the watchdog. */
  private heal(reason: string): void {
    if (this.stopped || this.healing) return
    this.lastAttempt = Date.now()
    this.healing = (async () => {
      if (this.failures === 0) console.warn(`[jarvis] wekwoord opnieuw starten: ${reason}`)
      await this.close()
      try {
        await this.open()
        if (this.failures > 0) console.info(`[jarvis] wekwoord weer aan na ${this.failures} mislukte pogingen`)
        this.failures = 0
      } catch (error) {
        if (this.failures === 0) console.warn('[jarvis] wekwoord kan de microfoon niet openen; blijft proberen', error)
        this.failures += 1
      }
    })().finally(() => {
      this.healing = null
    })
  }

  private async close(): Promise<void> {
    const { stream, context } = this
    this.stream = null
    this.context = null
    for (const track of stream?.getTracks() ?? []) track.stop()
    await context?.close().catch(() => undefined)
  }

  async pause(): Promise<void> {
    this.listening = false
  }

  async resume(): Promise<void> {
    this.listening = true
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.listening = false
    if (this.watchdog) clearInterval(this.watchdog)
    navigator.mediaDevices.removeEventListener('devicechange', this.deviceChanged)
    await this.healing
    await this.close()
  }
}
