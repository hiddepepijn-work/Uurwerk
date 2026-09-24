/**
 * Putting your plan on your phone.
 *
 * The direction that makes any of this worth building: you plan a fortnight in Uurwerk, and
 * tomorrow morning your phone already knows what you are doing.
 *
 * ── Why it only ever writes to one calendar ──────────────────────────────────────────────
 * Two writers on one collection is how a sync client eats a real appointment. Uurwerk writes
 * exclusively to a calendar it created — see `ensureUurwerkCalendar` — so it can rewrite that
 * collection as freely as it likes while your own calendars stay strictly read-only. The
 * awkward half of two-way sync, merging concurrent edits to the same event, simply never
 * arises.
 *
 * ── Why a full reconcile rather than a diff ──────────────────────────────────────────────
 * Replanning rewrites the week wholesale, so the interesting question is never "what changed"
 * but "what should be there now". Each push reads what is on the calendar, works out the
 * three sets — missing, stale, orphaned — and applies them. That is idempotent: pushing an
 * unchanged plan twice is a no-op, and a push interrupted half way is fixed by the next one
 * rather than leaving a mess only a human could untangle.
 *
 * The UID carries the plan block id, which is what lets a block be recognised across pushes
 * without storing a second mapping table that could drift out of step with the plan.
 */

import type { PlanBlock } from '@core/contract/types.js'
import { atMinuteOfDay } from '@core/util/time.js'

import type { Backend } from '../ipc.js'
import { log } from '../logger.js'
import { calDavProviderFor } from './index.js'
import type { ParsedEvent } from './ics-parse.js'

/** What one push did. Reported back so the UI never has to claim something it did not do. */
export interface PushOutcome {
  created: number
  updated: number
  removed: number
  unchanged: number
}

/** The marker that says a calendar entry belongs to a plan block, and which one. */
const UID_PREFIX = 'uurwerk-plan-'
const uidFor = (blockId: string): string => `${UID_PREFIX}${blockId}@uurwerk.app`
const isPlanUid = (uid: string): boolean => uid.startsWith(UID_PREFIX)

/**
 * One plan block as a calendar event.
 *
 * Breaks are deliberately not pushed. They are the absence of work rather than an
 * appointment, and a phone calendar peppered with fifteen-minute "Break" entries is noise
 * that makes the useful entries harder to see.
 */
function toEvent(block: PlanBlock): ParsedEvent | null {
  if (block.kind === 'break') return null

  const title = block.taskTitle ?? block.title ?? 'Planned work'
  return {
    uid: uidFor(block.id),
    summary: title,
    description: block.explanation,
    location: null,
    startsAt: atMinuteOfDay(block.date, block.startMin),
    endsAt: atMinuteOfDay(block.date, block.endMin),
    allDay: false,
    recurrenceRule: null,
    recurrenceId: null,
    cancelled: false,
    organizer: null,
    attendees: [],
    updatedAt: null
  }
}

/** Two events are the same appointment when nothing a reader would notice differs. */
const sameAppointment = (a: ParsedEvent, b: ParsedEvent): boolean =>
  a.summary === b.summary && a.startsAt === b.startsAt && a.endsAt === b.endsAt

/**
 * Reconciles the Uurwerk calendar with the accepted plans across a range of days.
 *
 * Only accepted plans: a draft is not a commitment, and putting one on your phone would
 * announce work you have not agreed to do.
 */
export async function pushPlan(
  backend: Backend,
  accountId: string,
  calendarId: string,
  days: string[]
): Promise<PushOutcome> {
  const store = backend.store
  const calendar = store.calendar.calendar(calendarId)
  if (!calendar) throw new Error(`Calendar not found: ${calendarId}`)

  const provider = calDavProviderFor(backend, accountId)

  const wanted = new Map<string, ParsedEvent>()
  for (const block of store.plans.acceptedBlocksForDays(days)) {
    const event = toEvent(block)
    if (event) wanted.set(event.uid, event)
  }

  // The window the reconcile is allowed to touch. Anything outside it is somebody else's
  // business — a push for next week must not delete last week's entries.
  const from = atMinuteOfDay(days[0] ?? '1970-01-01', 0)
  const to = atMinuteOfDay(days[days.length - 1] ?? '1970-01-01', 24 * 60)

  const existing = await provider.eventsIn(calendar.externalId, from, to)
  const onServer = new Map(existing.filter((event) => isPlanUid(event.uid)).map((e) => [e.uid, e]))

  const outcome: PushOutcome = { created: 0, updated: 0, removed: 0, unchanged: 0 }

  for (const [uid, event] of wanted) {
    const current = onServer.get(uid)
    if (!current) {
      await provider.createEvent(calendar.externalId, event)
      outcome.created += 1
    } else if (!sameAppointment(current, event)) {
      await provider.updateEvent(calendar.externalId, uid, event)
      outcome.updated += 1
    } else {
      outcome.unchanged += 1
    }
  }

  // Blocks that no longer exist: the plan changed, so the calendar has to lose them. Scoped
  // to entries this app wrote — anything you added to the calendar by hand survives.
  for (const uid of onServer.keys()) {
    if (wanted.has(uid)) continue
    await provider.deleteEvent(calendar.externalId, uid)
    outcome.removed += 1
  }

  log.info('Plan pushed to iCloud.', { accountId, ...outcome })
  return outcome
}

export { uidFor, isPlanUid, toEvent, sameAppointment }
