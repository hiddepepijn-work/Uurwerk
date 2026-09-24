/**
 * When may a screenshot be taken?
 *
 * The decision lives here, in core, with no filesystem and no Electron in sight, because it
 * is the one piece of the capture feature that has to be *provably* right. Everything the
 * main process does around it — probing the foreground window, encoding a JPEG, writing a
 * file — is mechanical. This is the part that decides whether your screen is recorded, so
 * it is the part that gets tests.
 *
 * Three rules shape it:
 *
 *   1. Capture follows tracking. No running segment, no frames. The app never records you
 *      while the timer is off, so stopping the timer is always a complete off switch.
 *   2. Every doubt resolves to *not* capturing. An unknown foreground window is treated
 *      exactly like a blocked one — if we cannot say what is on screen, we do not keep it.
 *   3. A captured frame is still not a shared frame. Everything here produces artefacts
 *      with included = false; the approval gate in the end-of-day wizard is separate and
 *      mandatory.
 */

// The quality profiles live in the contract rather than here: the settings screen needs the
// same numbers to tell you what a choice costs, and the renderer may only import contract.
export { CAPTURE_PROFILES, captureProfile, estimateStorage } from '../contract/types.js'

export type SkipReason =
  | 'disabled'
  | 'not-tracking'
  | 'too-soon'
  | 'idle'
  | 'blocklist'
  | 'unknown-window'

export interface CaptureDecision {
  capture: boolean
  reason?: SkipReason
  /** The blocklist entry that matched, for the log line and the toast. */
  matched?: string
}

const YES: CaptureDecision = { capture: true }
const no = (reason: SkipReason, matched?: string): CaptureDecision =>
  matched === undefined ? { capture: false, reason } : { capture: false, reason, matched }

/** Everything the decision needs that is knowable without asking the operating system. */
export interface CaptureTiming {
  enabled: boolean
  tracking: boolean
  intervalMin: number
  /** Epoch ms of the previous frame, or null when none was taken yet this run. */
  lastCaptureAt: number | null
  now: number
  /** Seconds since the last keyboard or mouse input, from powerMonitor. */
  idleSec: number
  idleTimeoutMin: number
}

/**
 * The cheap half: settings, the clock and the idle timer.
 *
 * Runs first so the expensive half — asking Windows which window has focus — happens at
 * most once per interval instead of once per tick.
 */
export function shouldAttempt(timing: CaptureTiming): CaptureDecision {
  if (!timing.enabled) return no('disabled')
  if (!timing.tracking) return no('not-tracking')

  const intervalMs = Math.max(1, timing.intervalMin) * 60_000
  if (timing.lastCaptureAt !== null && timing.now - timing.lastCaptureAt < intervalMs) {
    return no('too-soon')
  }

  // Idle capture would produce a wall of identical frames of whatever you walked away
  // from. The idle watchdog stops the timer anyway; this covers the gap before it fires.
  if (timing.idleSec >= Math.max(1, timing.idleTimeoutMin) * 60) return no('idle')

  return YES
}

/**
 * The expensive half: what is actually in front of you.
 *
 * `title` is null when the foreground window could not be identified. That is deliberately
 * not treated as "probably fine" — it is treated as blocked. Better a day with no frames
 * than one frame of a video call.
 */
export function windowAllows(title: string | null, blocklist: string[]): CaptureDecision {
  if (title === null) return no('unknown-window')

  const matched = matchBlocklist(title, blocklist)
  return matched === null ? YES : no('blocklist', matched)
}

/** The whole decision in one call. Used by the tests and by anything that has both halves. */
export function decide(
  timing: CaptureTiming,
  title: string | null,
  blocklist: string[]
): CaptureDecision {
  const timingDecision = shouldAttempt(timing)
  return timingDecision.capture ? windowAllows(title, blocklist) : timingDecision
}

/**
 * The first blocklist entry contained in the window title, or null.
 *
 * Substring, case-insensitive, on purpose: window titles are "Chat | Microsoft Teams" and
 * "Inbox - hidde@… - Outlook", never a bare application name. Blank entries are ignored —
 * an empty string is a substring of everything and would silently block all capture.
 */
export function matchBlocklist(title: string, blocklist: string[]): string | null {
  const haystack = title.toLowerCase()
  for (const entry of blocklist) {
    const needle = entry.trim().toLowerCase()
    if (needle.length > 0 && haystack.includes(needle)) return entry
  }
  return null
}

/** Human-readable skip reason, for the log and the settings screen. */
export function explainSkip(reason: SkipReason, matched?: string): string {
  switch (reason) {
    case 'disabled':
      return 'Automatic capture is switched off.'
    case 'not-tracking':
      return 'The timer is not running.'
    case 'too-soon':
      return 'The capture interval has not elapsed yet.'
    case 'idle':
      return 'You were idle.'
    case 'blocklist':
      return `The focused window matched the blocklist${matched ? ` (${matched})` : ''}.`
    case 'unknown-window':
      return 'The focused window could not be identified, so nothing was captured.'
  }
}
