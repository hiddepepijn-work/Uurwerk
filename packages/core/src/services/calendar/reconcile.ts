/**
 * Turning a classified appointment into hours.
 *
 * Everything in the app that answers "how much did you work" reads `time_segments` and only
 * `time_segments` — the stat cards, the week grid, planned-versus-actual, a task's logged
 * time, the supervisor's document. So an event you marked as counting toward your hours has
 * to *become* a segment. Storing `registration_mode` on the event and stopping there is what
 * made the classifier's "Hours to register" figure a number that appeared on screen and
 * nowhere else.
 *
 * The segment is derived, never authored. It is deleted and rewritten from the event on every
 * reclassification rather than patched, which is what keeps the stored `countsAsStageHours`
 * flag agreeing with the area you just chose. That is a deliberate exception to the tracking
 * service's rule that the flag is resolved once and frozen: that rule protects hours *you*
 * worked against a later reclassification of the area, and there is nothing to protect here —
 * the event is the source, and the segment is its shadow.
 */

import type { CalendarEvent } from '../../contract/types.js'
import { MINUTE_MS } from '../../util/time.js'

/**
 * The stretch an event should register as worked, or null when it registers none.
 *
 * `confirmedMin` wins over the event's own length when it is set: 'confirm' mode exists
 * precisely for the meeting scheduled for an hour that took twenty minutes, and the figure
 * you confirmed is the honest one.
 */
export function registrableWindow(
  event: CalendarEvent
): { startedAt: number; endedAt: number } | null {
  if (event.deletedAt !== null || event.cancelled) return null
  if (event.registrationMode === 'none' || !event.countsAsWorked) return null

  const minutes = event.confirmedMin ?? Math.round((event.endsAt - event.startsAt) / MINUTE_MS)
  if (minutes <= 0) return null

  return { startedAt: event.startsAt, endedAt: event.startsAt + minutes * MINUTE_MS }
}
