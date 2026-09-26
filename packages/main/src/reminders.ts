/**
 * The laptop's side of the reminders: the same list the phone schedules, shown as Windows
 * notifications when their moment comes — 15 minutes before a task or appointment, and
 * "verzamel je spullen" / "lukt het?" at 30 and 15 minutes before leaving.
 *
 * A check every half minute rather than timers per reminder: the plan changes under us
 * (sync, replans), and re-reading it is cheaper than keeping timers in step with it.
 */

import { Notification } from 'electron'
import { upcomingReminders } from '@core/services/reminders.js'
import { toIsoDate } from '@core/util/time.js'
import type { Backend } from '@backend/create.js'
import { log } from './logger.js'

const CHECK_MS = 30_000

let handle: NodeJS.Timeout | null = null
const shown = new Set<string>()

export function startReminders(backend: Backend, onOpen: () => void): void {
  stopReminders()
  // Start from now: reminders whose moment passed while the laptop was off stay unsaid.
  let checkedUntil = Date.now()

  const check = (): void => {
    const now = Date.now()
    try {
      const plan = backend.store.plans.accepted('day', toIsoDate(now))
      const blocks = plan ? backend.store.plans.blocks(plan.id) : []
      const events = backend.calendar.eventsInRange(now - 3_600_000, now + 6 * 3_600_000)

      for (const reminder of upcomingReminders(blocks, events, checkedUntil, now + 1)) {
        if (shown.has(reminder.key)) continue
        shown.add(reminder.key)
        const notification = new Notification({
          title: reminder.title,
          body: reminder.body,
          // Leaving is the one that must not be missed.
          urgency: reminder.kind === 'leave' ? 'critical' : 'normal'
        })
        notification.on('click', onOpen)
        notification.show()
      }
    } catch (error) {
      log.warn('Reminder check failed.', error)
    }
    checkedUntil = now + 1
  }

  handle = setInterval(check, CHECK_MS)
}

export function stopReminders(): void {
  if (handle) clearInterval(handle)
  handle = null
}
