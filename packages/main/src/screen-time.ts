/**
 * How long the machine was awake.
 *
 * Not `os.uptime()`: that only knows the current boot, so it cannot answer "how long was
 * this laptop on yesterday", and it keeps counting through sleep on some machines. Instead
 * this credits wall-clock minutes as they actually pass, one tick at a time.
 *
 * The whole design is about what happens when time is *not* passing normally:
 *
 *   - suspend / resume    the lid closes, ticks stop; on resume the gap is not credited
 *   - lock / unlock       the screen is on but nobody is there — same treatment
 *   - a long gap          a missed tick beyond the grace window means the app was frozen,
 *                         the machine slept without an event, or the clock jumped; the gap
 *                         is discarded rather than guessed at
 *   - midnight            a tick spanning midnight is split, so each day gets its own share
 *
 * Every one of those errs towards under-counting. A screen-time figure that is a little low
 * is a nuisance; one that quietly counts eight hours of sleep as "on" is a lie.
 */

import { powerMonitor } from 'electron'
import { toIsoDate } from '@core/util/time.js'
import type { Backend } from '@backend/create.js'
import { log } from './logger.js'

const TICK_MS = 60_000
/** A tick this late means time did not pass normally; the gap is dropped, not credited. */
const MAX_CREDIT_MS = 3 * TICK_MS

let handle: NodeJS.Timeout | null = null
let backend: Backend | null = null
let lastTickAt: number | null = null
/** Asleep or locked: the clock runs, this counter does not. */
let paused = false

export function startScreenTime(instance: Backend): void {
  backend = instance
  lastTickAt = Date.now()

  handle = setInterval(tick, TICK_MS)

  powerMonitor.on('suspend', () => pause('suspend'))
  powerMonitor.on('lock-screen', () => pause('lock'))
  powerMonitor.on('resume', () => resume('resume'))
  powerMonitor.on('unlock-screen', () => resume('unlock'))

  log.info('Screen-time sampling started.')
}

export function stopScreenTime(): void {
  // Credit the part-minute before shutting down, so quitting does not round away the tail.
  tick()
  if (handle) clearInterval(handle)
  handle = null
  lastTickAt = null
}

function pause(reason: string): void {
  if (paused) return
  tick()
  paused = true
  log.info(`Screen-time paused (${reason}).`)
}

function resume(reason: string): void {
  if (!paused) return
  paused = false
  // Start counting from now, not from the moment it paused — the gap was not awake time.
  lastTickAt = Date.now()
  log.info(`Screen-time resumed (${reason}).`)
}

function tick(): void {
  if (!backend || paused) return

  const now = Date.now()
  const since = lastTickAt ?? now
  lastTickAt = now

  const elapsed = now - since
  if (elapsed <= 0) return

  if (elapsed > MAX_CREDIT_MS) {
    // The machine slept without telling us, or the clock moved. Credit nothing.
    log.info('Screen-time gap discarded rather than credited.', { minutes: Math.round(elapsed / 60_000) })
    return
  }

  try {
    for (const slice of splitAcrossMidnight(since, now)) {
      backend.store.screenTime.add(slice.date, slice.minutes)
    }
  } catch (error) {
    // Sampling must never take the app down; a missed minute is not worth a crash.
    log.warn('Could not record screen time for this tick.', error)
  }
}

/**
 * Splits a span at local midnight so a minute worked at 00:00 lands on the new day.
 *
 * Only ever one boundary in practice — the tick is a minute — but written generally so a
 * long resume gap cannot silently dump an hour on the wrong date.
 */
function splitAcrossMidnight(
  fromMs: number,
  toMs: number
): Array<{ date: string; minutes: number }> {
  const out: Array<{ date: string; minutes: number }> = []
  let cursor = fromMs

  while (cursor < toMs) {
    const midnight = new Date(cursor)
    midnight.setHours(24, 0, 0, 0)
    const sliceEnd = Math.min(midnight.getTime(), toMs)
    out.push({ date: toIsoDate(cursor), minutes: (sliceEnd - cursor) / 60_000 })
    cursor = sliceEnd
  }

  return out
}
