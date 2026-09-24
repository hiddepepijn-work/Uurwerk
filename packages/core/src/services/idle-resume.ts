/**
 * Picking the task back up after an idle pause.
 *
 * The idle watchdog stops the timer and backdates the stop, so the minutes you were away
 * are never billed. That part is not negotiable. What it left you with, though, was a
 * timer that stays off until you notice and re-pick the task you were already on — so a
 * five-minute interruption costs an hour of untracked work when you forget.
 *
 * This decides when to start it again, and the rules are all about not inventing time:
 *
 *   1. Only an *idle* stop arms a resume. Stopping deliberately means you are done, and
 *      an app that restarts a timer you switched off is an app you switch off for good.
 *   2. Resuming starts counting from the moment you come back, never from when you left.
 *      The gap stays unbilled — resuming is not backfilling.
 *   3. It expires. Coming back after two hours is a new decision, not a continuation, and
 *      the next morning is certainly not.
 *   4. Anything you do yourself — starting, switching, stopping — disarms it. Your action
 *      is more recent information than the pause.
 *
 * A pure function so all of that can be tested without a watchdog, a clock or an Electron
 * process; the main process supplies the readings and does what it says.
 */

/** After this long, coming back is a fresh decision rather than picking up where you left. */
export const RESUME_WINDOW_MS = 2 * 60 * 60 * 1000

/** Seconds of input silence below which the user is considered present again. */
const PRESENT_BELOW_SEC = 30

export interface ArmedResume {
  /** The task that was running when idle stopped it. Null tasks are not worth resuming. */
  taskId: string
  /** When the idle stop happened. */
  at: number
}

export interface ResumeReading {
  armed: ArmedResume | null
  enabled: boolean
  /** True when a run is already open; resuming would then be meaningless. */
  running: boolean
  /** Seconds since the last keyboard or mouse input. */
  idleSeconds: number
  now: number
}

export type ResumeDecision =
  | { action: 'resume'; taskId: string }
  /** Nothing to do now, but keep waiting for the user to come back. */
  | { action: 'wait' }
  /** The window has passed; forget it rather than resuming much later. */
  | { action: 'expire' }

export function decideResume(reading: ResumeReading): ResumeDecision {
  if (!reading.armed) return { action: 'wait' }

  // A run already going means something else started it; the arm is stale either way.
  if (reading.running) return { action: 'expire' }

  if (!reading.enabled) return { action: 'expire' }

  if (reading.now - reading.armed.at > RESUME_WINDOW_MS) return { action: 'expire' }

  // Still away. Keep waiting — this is the common case, checked every watchdog tick.
  if (reading.idleSeconds >= PRESENT_BELOW_SEC) return { action: 'wait' }

  return { action: 'resume', taskId: reading.armed.taskId }
}
