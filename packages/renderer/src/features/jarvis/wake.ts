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
  constructor() { super(); this.buffer = new Int16Array(${CHUNK}); this.fill = 0 }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    for (let i = 0; i < channel.length; i++) {
      const sample = Math.max(-1, Math.min(1, channel[i]))
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

export class WakeWord {
  private listening = true

  private constructor(
    private readonly context: AudioContext,
    private readonly stream: MediaStream
  ) {}

  static async start(): Promise<WakeWord> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
    })
    const context = new AudioContext({ sampleRate: RATE })
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
    await context.audioWorklet.addModule(url)
    URL.revokeObjectURL(url)
    const wake = new WakeWord(context, stream)
    const node = new AudioWorkletNode(context, 'uurwerk-wake-capture')
    node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (wake.listening) void api.window.wakeAudio(event.data).catch(() => undefined)
    }
    context.createMediaStreamSource(stream).connect(node)
    await context.resume()
    return wake
  }

  async pause(): Promise<void> {
    this.listening = false
  }

  async resume(): Promise<void> {
    this.listening = true
  }

  async stop(): Promise<void> {
    this.listening = false
    for (const track of this.stream.getTracks()) track.stop()
    await this.context.close().catch(() => undefined)
  }
}
