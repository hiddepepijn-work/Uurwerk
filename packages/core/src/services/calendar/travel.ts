/**
 * Travel around an appointment, as events in their own right.
 *
 * Two integer columns would have been less code and wrong. A journey occupies the calendar,
 * blocks planning, may or may not count as worked time, and — once calendars are writable —
 * belongs in Outlook so colleagues can see you are on a train. Every one of those behaviours
 * already exists for events, so travel is an event: `kind = 'travel'`, pointing at the
 * appointment it belongs to.
 *
 * The classification is inherited rather than asked for again: travelling to a Maasarend
 * meeting is Maasarend work in the Stage area. Only the work type differs, because what you
 * are doing is travelling.
 *
 * Whether that time counts toward worked hours is a separate decision, and deliberately so —
 * an hour on a train to a client is arguably work; the drive to a lecture may not be.
 */

import type { CalendarEvent, NewCalendarEvent, TravelPlan } from '../../contract/types.js'

/** The work type every travel block carries, seeded by migration 013. */
export const TRAVEL_WORK_TYPE_ID = 'work-type-travel'

const MINUTE_MS = 60_000

/**
 * The travel blocks an appointment should have, given a plan.
 *
 * Outbound ends exactly when the appointment starts and the return begins exactly when it
 * ends: a gap would be time nobody can use, and an overlap would double-book you.
 */
export function travelEventsFor(
  parent: CalendarEvent,
  plan: TravelPlan
): NewCalendarEvent[] {
  const out: NewCalendarEvent[] = []

  const inherited = {
    areaId: parent.areaId,
    organizationId: parent.organizationId,
    projectId: parent.projectId,
    workTypeId: TRAVEL_WORK_TYPE_ID,
    origin: parent.origin,
    parentEventId: parent.id,
    kind: 'travel' as const,
    // Travel blocks the calendar whether or not it is paid.
    includeInPlanning: true,
    countsAsWorked: plan.countsAsWorked,
    registrationMode: plan.countsAsWorked ? ('calendar' as const) : ('none' as const),
    // Inherited, never asked about again: it belongs to a decision you already made.
    classificationStatus: parent.classificationStatus,
    location: parent.location
  }

  if (plan.outboundMin > 0) {
    out.push({
      ...inherited,
      title: `Travel to ${parent.title}`,
      travelDirection: 'outbound',
      startsAt: parent.startsAt - plan.outboundMin * MINUTE_MS,
      endsAt: parent.startsAt
    })
  }

  if (plan.returnMin > 0) {
    out.push({
      ...inherited,
      title: `Travel back from ${parent.title}`,
      travelDirection: 'return',
      startsAt: parent.endsAt,
      endsAt: parent.endsAt + plan.returnMin * MINUTE_MS
    })
  }

  return out
}

export interface TravelShift {
  eventId: string
  startsAt: number
  endsAt: number
}

/**
 * Where travel blocks move to when their appointment moves.
 *
 * Durations are preserved rather than recomputed — you said the journey takes forty-five
 * minutes, and moving the meeting does not change that. A block you have edited yourself is
 * left alone: `travelDetached` means your version is the more recent decision, and an
 * automatic move would quietly discard it.
 */
export function travelAfterParentMoved(
  parent: CalendarEvent,
  travel: CalendarEvent[]
): TravelShift[] {
  const out: TravelShift[] = []

  for (const block of travel) {
    if (block.travelDetached) continue

    const duration = block.endsAt - block.startsAt
    if (block.travelDirection === 'outbound') {
      out.push({
        eventId: block.id,
        startsAt: parent.startsAt - duration,
        endsAt: parent.startsAt
      })
    } else if (block.travelDirection === 'return') {
      out.push({
        eventId: block.id,
        startsAt: parent.endsAt,
        endsAt: parent.endsAt + duration
      })
    }
  }

  return out
}

/**
 * Total minutes an appointment costs: the event plus whatever travel counts as worked.
 *
 * This is the "hours to register" figure, and it is deliberately not the same as the time a
 * timer would record — it is what the calendar claims, which end-of-day gets to argue with.
 */
export function registrableMinutes(parent: CalendarEvent, travel: CalendarEvent[]): number {
  const own =
    parent.registrationMode === 'none'
      ? 0
      : (parent.confirmedMin ?? Math.round((parent.endsAt - parent.startsAt) / MINUTE_MS))

  const journey = travel
    .filter((block) => block.countsAsWorked && block.registrationMode !== 'none')
    .reduce(
      (sum, block) =>
        sum + (block.confirmedMin ?? Math.round((block.endsAt - block.startsAt) / MINUTE_MS)),
      0
    )

  return own + journey
}
