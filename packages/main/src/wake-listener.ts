/**
 * The main-process end of "Hey Jarvis": the corner window streams the microphone here, the
 * detector (wakeword.ts) listens, and on the wake word the corner is called up — the same
 * as the Jarvis hotkey.
 */

import { app } from 'electron'

import { emitEvent } from './events.js'
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
      const { heard, best } = await (await load()).push(samples)
      chunks += 1
      closest = Math.max(closest, best)
      if (Date.now() - lastReport > 60_000) {
        if (lastReport > 0) {
          log.info('Wake word listening.', {
            chunks,
            closest: Math.round(closest * 100) / 100,
            level: Math.round((energy / Math.max(1, chunks)) * 10000) / 10000,
            loudest: Math.round(loudest * 1000) / 1000
          })
        }
        chunks = 0
        closest = 0
        energy = 0
        loudest = 0
        lastReport = Date.now()
      }
      if (!heard) return
      log.info('Heard "Hey Jarvis".')
      showJarvis()
      emitEvent('jarvis:summon', {})
    })
    .catch(() => undefined)
  return queue
}
