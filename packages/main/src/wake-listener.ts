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
      const { heard } = await (await load()).push(new Int16Array(pcm))
      if (!heard) return
      log.info('Heard "Hey Jarvis".')
      showJarvis()
      emitEvent('jarvis:summon', {})
    })
    .catch(() => undefined)
  return queue
}
