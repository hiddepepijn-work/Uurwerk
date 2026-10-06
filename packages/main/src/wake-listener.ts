/**
 * The main-process end of "Hey Jarvis": the corner window streams the microphone here, the
 * detector (wakeword.ts) listens, and on the wake word the corner is called up — the same
 * as the Jarvis hotkey.
 */

import { app } from 'electron'

import { emitEvent } from './events.js'
import { audioContextNow } from './audio-context.js'
import { log } from './logger.js'
import { modelDir, WakeWordDetector } from './wakeword.js'
import { showJarvis } from './windows.js'

let detector: Promise<WakeWordDetector> | null = null
/** For the log: how close it came to "Hey Jarvis" lately, and whether audio arrives at all. */
let closest = 0
let chunks = 0
/** How loud the microphone came in: silence here means the audio never arrives. */
let loudest = 0
let energy = 0
let lastReport = 0
/**
 * With music or a video playing a "Hey Jarvis" must be much surer: the false ones heard in
 * songs scored 0.45–0.49 (2 Oct 2026). A clear, close "Hey Jarvis" still gets through; the
 * hotkey always does.
 */
const THRESHOLD_WITH_SOUND = 0.75
/** Chunks skipped for a call since the last report, and whether the last chunk was one. */
let skipped = 0
let wasSkipping = false
/** One chunk at a time: the models are not re-entrant, and order matters. */
let queue: Promise<void> = Promise.resolve()

function load(): Promise<WakeWordDetector> {
  detector ??= WakeWordDetector.load(modelDir(app.getAppPath())).catch((error: unknown) => {
    log.warn('The wake word models did not load.', error)
    detector = null
    throw error
  })
  return detector
}

export function hearWakeAudio(pcm: ArrayBuffer): Promise<void> {
  queue = queue
    .then(async () => {
      const samples = new Int16Array(pcm)
      let sum = 0
      for (const sample of samples) sum += (sample / 32768) ** 2
      const rms = Math.sqrt(sum / Math.max(1, samples.length))
      loudest = Math.max(loudest, rms)
      energy += rms
      const detector = await load()
      const context = audioContextNow()
      // In a call everything said is for someone else.
      if (context.calling) {
        skipped += 1
        wasSkipping = true
        return
      }
      if (wasSkipping) {
        wasSkipping = false
        detector.skipped()
      }
      const { heard, best } = await detector.push(samples, context.playing ? THRESHOLD_WITH_SOUND : undefined)
      chunks += 1
      closest = Math.max(closest, best)
      if (Date.now() - lastReport > 60_000) {
        if (lastReport > 0) {
          log.info('Wake word listening.', {
            chunks,
            closest: Math.round(closest * 100) / 100,
            level: Math.round((energy / Math.max(1, chunks)) * 10000) / 10000,
            loudest: Math.round(loudest * 1000) / 1000,
            skippedForCall: skipped
          })
        }
        chunks = 0
        skipped = 0
        closest = 0
        energy = 0
        loudest = 0
        lastReport = Date.now()
      }
      if (!heard) return
      log.info('Heard "Hey Jarvis".', { score: Math.round(best * 100) / 100, playing: context.playing })
      showJarvis()
      emitEvent('jarvis:summon', {})
    })
    .catch(() => undefined)
  return queue
}
