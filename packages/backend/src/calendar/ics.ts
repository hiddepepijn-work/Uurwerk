/**
 * A subscribed calendar: one URL that returns an .ics file.
 *
 * The least capable provider and, for a managed tenant, often the only one available —
 * publishing a calendar is a user action, where registering an application is an
 * administrator's. Read-only by nature: there is nothing to write to.
 *
 * Two honest limitations, surfaced rather than hidden:
 *   - **No incremental sync.** The whole file is fetched every time. It is a few hundred
 *     kilobytes, so this is fine hourly and would not be fine every minute.
 *   - **The publisher decides how fresh it is.** Microsoft regenerates a published calendar
 *     on its own schedule, sometimes hours behind. Nothing here can make that faster, and
 *     the UI says so instead of implying the delay is Uurwerk's.
 */

import { parseIcs } from './ics-parse.js'
import {
  UnsupportedOperationError,
  type CalendarProvider,
  type ProviderCalendar,
  type ProviderEvents
} from './provider.js'

const TIMEOUT_MS = 30_000
/** Published calendars are small; anything this large is not one. */
const MAX_BYTES = 8 * 1024 * 1024

export class IcsProvider implements CalendarProvider {
  readonly id = 'ics' as const
  readonly capabilities = { read: true, write: false, incrementalSync: false }

  constructor(
    private readonly url: string,
    /** What to call it when the file carries no name of its own. */
    private readonly fallbackName = 'Subscribed calendar'
  ) {}

  /**
   * Fetches once to prove the link works before anything is stored.
   *
   * The common mistakes have their own messages: the HTML link instead of the ICS one, and
   * a link whose permission was set to "availability only", which returns a calendar full
   * of events called "Busy" — technically valid, and useless.
   */
  async connect(): Promise<{ displayName: string; accountIdentifier: string | null }> {
    const calendar = await this.fetchCalendar()

    if (calendar.events.length > 0 && calendar.events.every((event) => isPlaceholder(event.summary))) {
      throw new Error(
        'That calendar only shares availability, so every event comes through as “Busy”. ' +
          'Republish it with “Can view all details” to see titles.'
      )
    }

    return {
      displayName: calendar.name ?? this.fallbackName,
      accountIdentifier: hostOf(this.url)
    }
  }

  async disconnect(): Promise<void> {
    // Nothing to revoke: the credential is the URL, and forgetting it is the whole job.
  }

  async getCalendars(): Promise<ProviderCalendar[]> {
    const calendar = await this.fetchCalendar()
    return [
      {
        externalId: this.url,
        name: calendar.name ?? this.fallbackName,
        writable: false
      }
    ]
  }

  /**
   * Everything in the window.
   *
   * Recurring events are returned as their master with the rule attached; expanding them is
   * a display concern and happens closer to the screen, where the visible range is known.
   */
  async getEvents(fromMs: number, toMs: number): Promise<ProviderEvents> {
    const calendar = await this.fetchCalendar()

    const events = calendar.events.filter(
      (event) =>
        // A recurring master may start long before the window and still occur inside it.
        event.recurrenceRule !== null || (event.startsAt < toMs && event.endsAt > fromMs)
    )

    return { events, syncToken: null }
  }

  createEvent(): Promise<{ externalId: string; etag: string | null }> {
    throw new UnsupportedOperationError('A subscribed calendar', 'create events')
  }

  updateEvent(): Promise<{ etag: string | null }> {
    throw new UnsupportedOperationError('A subscribed calendar', 'change events')
  }

  deleteEvent(): Promise<void> {
    throw new UnsupportedOperationError('A subscribed calendar', 'delete events')
  }

  private async fetchCalendar(): Promise<ReturnType<typeof parseIcs>> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

    try {
      // webcal:// is the same thing wearing a different hat.
      const url = this.url.replace(/^webcal:\/\//i, 'https://')
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'text/calendar, text/plain' }
      })

      if (!response.ok) {
        throw new Error(
          response.status === 404
            ? 'That link returned nothing. Check that the calendar is still published.'
            : `The calendar could not be fetched: ${response.status} ${response.statusText}`
        )
      }

      const text = await response.text()
      if (text.length > MAX_BYTES) {
        throw new Error('That calendar is unusually large; it does not look like a published calendar.')
      }
      if (!text.includes('BEGIN:VCALENDAR')) {
        throw new Error(
          'That link did not return a calendar. Make sure you copied the ICS link rather than the HTML one.'
        )
      }

      return parseIcs(text)
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`The calendar did not respond within ${TIMEOUT_MS / 1000} seconds.`)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}

/** "Busy", "Bezet", "Private" — what a calendar shared without details returns. */
const isPlaceholder = (summary: string): boolean =>
  ['busy', 'bezet', 'private', 'privé', 'no title', '(no title)'].includes(summary.trim().toLowerCase())

function hostOf(url: string): string | null {
  try {
    return new URL(url.replace(/^webcal:\/\//i, 'https://')).host
  } catch {
    return null
  }
}
