/**
 * "Hey Jarvis" on the laptop, with openWakeWord: three small ONNX models run on this
 * machine, nothing goes out. The same pipeline as openWakeWord's own Python:
 *
 *   16 kHz audio, 80 ms at a time
 *     → melspectrogram (32 bands, 10 ms hop)          ~8 frames per 80 ms
 *     → embedding of the last 76 mel frames            one 96-number vector per 80 ms
 *     → "hey jarvis" model over the last 16 vectors    a score from 0 to 1
 *
 * The corner window records the microphone and hands the audio over; the models run here in
 * the main process (onnxruntime-node), which keeps WebAssembly and model files out of a page
 * loaded from file://. The code and models are openWakeWord's (Apache-2.0 code; the
 * pre-trained models are for non-commercial use, which this is).
 */

import { join } from 'node:path'

import * as ort from 'onnxruntime-node'

/** 80 ms at 16 kHz: the step the whole pipeline moves in. */
export const CHUNK = 1280
/** Extra samples in front of each chunk, so the melspectrogram's window has history. */
const OVERLAP = 480
const MEL_WINDOW = 76
const FEATURE_WINDOW = 16

export interface WakeOptions {
  /**
   * Score above which it counts as heard. openWakeWord's default is 0.5; a Dutch "Hé Jarvis"
   * lands just under it, and other speech stays near zero, so 0.4 (npm run test:wakeword).
   */
  threshold?: number
  /** After a detection, this long without another, in audio time. */
  refractoryMs?: number
}

export class WakeWordDetector {
  private raw = new Int16Array(CHUNK + OVERLAP)
  private mel: Float32Array[] = Array.from({ length: MEL_WINDOW }, () => new Float32Array(32).fill(1))
  private features: Float32Array[] = []
  private pending: number[] = []
  /** The first frames after a start are unreliable; openWakeWord ignores five. */
  private warmup = 5
  /** Samples processed; the refractory period counts in audio, not in wall-clock time. */
  private processed = 0
  private quietUntil = 0

  private constructor(
    private readonly melspec: ort.InferenceSession,
    private readonly embedding: ort.InferenceSession,
    private readonly keyword: ort.InferenceSession,
    private readonly options: Required<WakeOptions>
  ) {}

  static async load(dir: string, options: WakeOptions = {}): Promise<WakeWordDetector> {
    const [melspec, embedding, keyword] = await Promise.all(
      ['melspectrogram.onnx', 'embedding_model.onnx', 'hey_jarvis_v0.1.onnx'].map((file) =>
        ort.InferenceSession.create(join(dir, file), { intraOpNumThreads: 1, interOpNumThreads: 1 })
      )
    )
    const detector = new WakeWordDetector(melspec!, embedding!, keyword!, {
      threshold: options.threshold ?? 0.4,
      refractoryMs: options.refractoryMs ?? 2000
    })
    await detector.prime()
    return detector
  }

  /**
   * Fills the feature history with four seconds of faint noise, as openWakeWord does, so the
   * model has sixteen vectors to look at from the first chunk on.
   */
  private async prime(): Promise<void> {
    const noise = new Int16Array(16000 * 4)
    for (let i = 0; i < noise.length; i++) noise[i] = Math.round((Math.random() * 2 - 1) * 1000)
    const frames = await this.melFrames(noise)
    for (let end = MEL_WINDOW; end <= frames.length; end += 8) {
      this.features.push(await this.embed(frames.slice(end - MEL_WINDOW, end)))
    }
    this.features = this.features.slice(-FEATURE_WINDOW * 4)
  }

  private async melFrames(samples: Int16Array): Promise<Float32Array[]> {
    const input = new ort.Tensor('float32', Float32Array.from(samples), [1, samples.length])
    const output = (await this.melspec.run({ [this.melspec.inputNames[0]!]: input }))[this.melspec.outputNames[0]!]!
    const data = output.data as Float32Array
    const rows: Float32Array[] = []
    for (let offset = 0; offset + 32 <= data.length; offset += 32) {
      // openWakeWord's scaling of the melspectrogram before the embedding model.
      rows.push(data.slice(offset, offset + 32).map((value) => value / 10 + 2))
    }
    return rows
  }

  private async embed(window: Float32Array[]): Promise<Float32Array> {
    const flat = new Float32Array(MEL_WINDOW * 32)
    window.forEach((row, index) => flat.set(row, index * 32))
    const input = new ort.Tensor('float32', flat, [1, MEL_WINDOW, 32, 1])
    const output = (await this.embedding.run({ [this.embedding.inputNames[0]!]: input }))[this.embedding.outputNames[0]!]!
    return Float32Array.from(output.data as Float32Array)
  }

  private async score(): Promise<number> {
    const recent = this.features.slice(-FEATURE_WINDOW)
    const flat = new Float32Array(FEATURE_WINDOW * 96)
    recent.forEach((row, index) => flat.set(row, index * 96))
    const input = new ort.Tensor('float32', flat, [1, FEATURE_WINDOW, 96])
    const output = (await this.keyword.run({ [this.keyword.inputNames[0]!]: input }))[this.keyword.outputNames[0]!]!
    return (output.data as Float32Array)[0] ?? 0
  }

  /**
   * After a stretch of audio it did not hear (a call): what it remembers is from before, so
   * it scores nothing until the whole window is new again.
   */
  skipped(): void {
    this.pending = []
    this.warmup = FEATURE_WINDOW
  }

  /**
   * Takes 16 kHz 16-bit mono audio in any amount; runs the models once per 80 ms of it.
   * Returns true when "hey jarvis" was heard in what came in. `threshold` overrides the
   * usual one for this audio (music playing asks for a surer call).
   */
  async push(samples: Int16Array, threshold = this.options.threshold): Promise<{ heard: boolean; best: number }> {
    for (const sample of samples) this.pending.push(sample)
    let heard = false
    let best = 0
    while (this.pending.length >= CHUNK) {
      const chunk = Int16Array.from(this.pending.splice(0, CHUNK))
      // The last OVERLAP samples of what came before, then this chunk.
      const window = new Int16Array(CHUNK + OVERLAP)
      window.set(this.raw.subarray(this.raw.length - OVERLAP), 0)
      window.set(chunk, OVERLAP)
      this.raw = window

      this.mel.push(...(await this.melFrames(window)))
      if (this.mel.length > 970) this.mel = this.mel.slice(-970)
      this.features.push(await this.embed(this.mel.slice(-MEL_WINDOW)))
      if (this.features.length > 120) this.features = this.features.slice(-120)

      const value = await this.score()
      this.processed += CHUNK
      if (this.warmup > 0) {
        this.warmup -= 1
        continue
      }
      best = Math.max(best, value)
      if (value >= threshold && this.processed >= this.quietUntil) {
        heard = true
        this.quietUntil = this.processed + (this.options.refractoryMs / 1000) * 16000
      }
    }
    return { heard, best }
  }
}

/** Where the models are: in the app's own folder, next to the main process's source. */
export const modelDir = (appPath: string): string => join(appPath, 'packages', 'main', 'assets', 'wakeword')
