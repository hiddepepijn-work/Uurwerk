import { BuiltInKeyword, PorcupineWorker } from '@picovoice/porcupine-web'
import { WebVoiceProcessor } from '@picovoice/web-voice-processor'

// The model ships inside the bundle: a page loaded from file:// cannot fetch files next to it.
import model from './assets/porcupine_params.pv?base64'

/**
 * Listening for "Jarvis" on the laptop, with Picovoice Porcupine: it runs entirely on this
 * machine, as WebAssembly, and only checks its AccessKey online. Nothing you say is sent
 * anywhere until the wake word is heard; then the live conversation takes the microphone.
 *
 * Paused while a conversation runs, so Jarvis saying his own name cannot call him again.
 */
export class WakeWord {
  private listening = false

  private constructor(private readonly worker: PorcupineWorker) {}

  static async start(accessKey: string, onWake: () => void): Promise<WakeWord> {
    const worker = await PorcupineWorker.create(
      accessKey,
      [{ builtin: BuiltInKeyword.Jarvis, sensitivity: 0.6 }],
      () => onWake(),
      { base64: model, forceWrite: true }
    )
    const wake = new WakeWord(worker)
    await wake.resume()
    return wake
  }

  async pause(): Promise<void> {
    if (!this.listening) return
    this.listening = false
    await WebVoiceProcessor.unsubscribe(this.worker)
  }

  async resume(): Promise<void> {
    if (this.listening) return
    this.listening = true
    await WebVoiceProcessor.subscribe(this.worker)
  }

  async stop(): Promise<void> {
    await this.pause()
    await this.worker.release()
    this.worker.terminate()
  }
}
