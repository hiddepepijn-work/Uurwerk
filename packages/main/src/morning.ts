/**
 * "You have not planned today yet."
 *
 * The planner is only worth having if it is used before the day starts rather than
 * reconstructed after it ends, and the one moment that reliably decides which of those
 * happens is the first hour at the desk. So this asks once, in the morning, and then stays
 * quiet — a reminder that fires twice is a reminder that gets switched off.
 *
 * Deliberately narrow: it never opens a window by itself, never starts a timer, and never
 * fires on a day the availability pattern says you do not work.
 */

import { Notification } from 'electron'
import { toIsoDate, toIsoWeek } from '@core/util/time.js'
import type { Backend } from '@backend/create.js'
import { log } from './logger.js'

/** Half-hourly is precise enough for something that may only fire once a day. */
const CHECK_INTERVAL_MS = 30 * 60 * 1000

/** Before this it is too early to know how the day looks; after it, the day has begun. */
const EARLIEST_MIN = 7 * 60
const LATEST_MIN = 12 * 60

let handle: NodeJS.Timeout | null = null
/** The day we have already asked about, so a long-running app asks once and not eight times. */
let askedOn: string | null = null

export function startMorningCheck(backend: Backend, onOpenPlanner: () => void): void {
  const check = (): void => {
    try {
      if (shouldAsk(backend)) ask(onOpenPlanner)
    } catch (error) {
      // A failed check must never take the app down; it is a notification, not the product.
      log.warn('The morning plan check failed and was skipped.', error)
    }
  }

  handle = setInterval(check, CHECK_INTERVAL_MS)
  check()
}

export function stopMorningCheck(): void {
  if (handle) clearInterval(handle)
  handle = null
}

/** Exposed for the tray menu: asks again today even if the notification already fired. */
export function resetMorningCheck(): void {
  askedOn = null
}

function shouldAsk(backend: Backend, now = Date.now()): boolean {
  const settings = backend.store.settings.get()
  if (!settings.showMorningNotification) return false

  const today = toIsoDate(now)
  if (askedOn === today) return false

  const date = new Date(now)
  const nowMin = date.getHours() * 60 + date.getMinutes()
  if (nowMin < EARLIEST_MIN || nowMin >= LATEST_MIN) return false

  // Not a working day? Then there is nothing to plan. An explicit availability row wins;
  // without one, the weekend is assumed to be free.
  const weekday = ((date.getDay() + 6) % 7) + 1
  const availability = backend.store.availability
    .forWeek(toIsoWeek(now))
    .find((row) => row.weekday === weekday)

  if (availability ? !availability.enabled : weekday > 5) return false

  // Already planned — including a plan with nothing in it, which is still a decision.
  const accepted = backend.store.plans.accepted('day', today)
  if (accepted) return false

  askedOn = today
  return true
}

function ask(onOpenPlanner: () => void): void {
  if (!Notification.isSupported()) {
    log.info('Today has no plan yet, but this system does not support notifications.')
    return
  }

  const notification = new Notification({
    title: 'Today has no plan yet',
    body: 'Open Uurwerk to plan the day, or ignore this — tracking works either way.',
    silent: true
  })

  notification.on('click', () => onOpenPlanner())
  notification.show()
  log.info('Asked about planning the day.')
}
