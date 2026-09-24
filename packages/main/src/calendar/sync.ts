/**
 * Bringing a provider's events into Uurwerk.
 *
 * Provider-agnostic on purpose: it takes parsed events and a store, and knows nothing about
 * ICS, Graph or CalDAV. When Outlook arrives it uses this same path.
 *
 * The whole method is built around one lookup. Every incoming event is matched by
 * (account, external id) against `calendar_event_links` **before** anything is created. A
 * hit is an update; only a miss creates. That is what makes re-importing safe, and it is
 * what will stop an event Uurwerk pushed outward from returning as a stranger.
 *
 * What it deliberately does not do is overwrite your work. An imported event's times and
 * title are the provider's business; its classification, its planning flag and its travel
 * are yours, and a re-sync leaves all of that alone.
 */

import type { CalendarEvent, CalendarOrigin } from '@core/contract/types.js'
import type { Store } from '@core/db/index.js'
import { CalendarService, classify } from '@core/services/calendar/index.js'

import { log } from '../logger.js'
import type { ParsedEvent } from './ics-parse.js'

export interface SyncOutcome {
  imported: number
  updated: number
  cancelled: number
  /** Events that arrived confident enough to classify without asking. */
  autoClassified: number
  /** Events now waiting for a decision. */
  pending: number
}

export function importEvents(input: {
  store: Store
  accountId: string
  calendarId: string
  origin: CalendarOrigin
  events: ParsedEvent[]
}): SyncOutcome {
  const { store, accountId, calendarId, origin } = input
  const settings = store.settings.get()
  const service = new CalendarService(store)

  const outcome: SyncOutcome = {
    imported: 0,
    updated: 0,
    cancelled: 0,
    autoClassified: 0,
    pending: 0
  }

  store.db.transaction(() => {
    const context = {
      rules: store.calendarRules.list(),
      areas: store.areas.list(),
      organizations: store.organizations.list(),
      projects: store.projects.list(),
      workTypes: store.workTypes.list()
    }
    const calendar = store.calendar.calendar(calendarId)

    for (const incoming of input.events) {
      const existing = store.calendar.eventForExternalId(accountId, incoming.uid)

      if (existing) {
        // The provider owns when and what it is called; Uurwerk owns what it means.
        const changed =
          existing.startsAt !== incoming.startsAt ||
          existing.endsAt !== incoming.endsAt ||
          existing.title !== incoming.summary ||
          existing.cancelled !== incoming.cancelled

        if (changed) {
          // Moving the appointment drags its travel blocks along, which is exactly the
          // behaviour that made travel worth modelling as events.
          service.moveEvent(existing.id, incoming.startsAt, incoming.endsAt)
          store.calendar.updateEvent(existing.id, {
            title: incoming.summary,
            description: incoming.description,
            location: incoming.location,
            cancelled: incoming.cancelled,
            attendees: incoming.attendees,
            organizer: incoming.organizer
          })
          outcome.updated += 1
          if (incoming.cancelled) outcome.cancelled += 1
        }

        store.calendar.linkEvent({
          eventId: existing.id,
          accountId,
          calendarId,
          externalId: incoming.uid,
          externalUpdatedAt: incoming.updatedAt,
          syncStatus: 'synced'
        })
        continue
      }

      // New to us. Classify before storing, so a confident guess never appears as a
      // question — the whole point of the confidence threshold.
      const suggestion = classify(
        {
          title: incoming.summary,
          location: incoming.location,
          organizer: incoming.organizer,
          attendees: incoming.attendees,
          calendar
        },
        context
      )

      const decided =
        settings.calendarClassification !== 'never' &&
        settings.calendarClassification !== 'always-ask' &&
        suggestion.confidence >= settings.calendarAskBelow

      const created = store.calendar.createEvent({
        title: incoming.summary,
        description: incoming.description,
        location: incoming.location,
        startsAt: incoming.startsAt,
        endsAt: incoming.endsAt,
        allDay: incoming.allDay,
        recurrenceRule: incoming.recurrenceRule,
        originalStartsAt: incoming.recurrenceId,
        organizer: incoming.organizer,
        attendees: incoming.attendees,
        origin,
        areaId: suggestion.areaId,
        organizationId: suggestion.organizationId,
        projectId: suggestion.projectId,
        workTypeId: suggestion.workTypeId,
        classificationStatus: decided ? 'confirmed' : 'suggested',
        confidence: suggestion.confidence,
        // A birthday calendar is visible without owning the hour.
        includeInPlanning: !calendar?.ignoreForPlanning,
        // Nothing counts as worked time until someone says so — an imported meeting is not
        // automatically an hour on the internship.
        registrationMode: 'none',
        countsAsWorked: false
      })

      store.calendar.linkEvent({
        eventId: created.id,
        accountId,
        calendarId,
        externalId: incoming.uid,
        externalUpdatedAt: incoming.updatedAt,
        syncStatus: 'synced'
      })

      outcome.imported += 1
      if (decided) outcome.autoClassified += 1
      else outcome.pending += 1
    }
  })

  log.info('Calendar import finished.', outcome)
  return outcome
}

/**
 * Events the provider no longer lists.
 *
 * Marked gone rather than deleted, and only for events that came from that account: an
 * appointment you created in Uurwerk must not disappear because a subscription stopped
 * mentioning it.
 */
export function markMissingAsDeleted(input: {
  store: Store
  accountId: string
  seenExternalIds: Set<string>
  windowStartMs: number
  windowEndMs: number
}): number {
  const { store, accountId, seenExternalIds } = input
  let removed = 0

  store.db.transaction(() => {
    for (const event of store.calendar.eventsInRange(input.windowStartMs, input.windowEndMs)) {
      const link = store.calendar.links(event.id).find((entry) => entry.accountId === accountId)
      if (!link || seenExternalIds.has(link.externalId)) continue

      store.calendar.softDelete(event.id)
      store.calendar.setSyncStatus(link.id, 'deleted')
      removed += 1
    }
  })

  return removed
}

export type { CalendarEvent }
