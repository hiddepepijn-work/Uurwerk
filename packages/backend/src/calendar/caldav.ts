/**
 * iCloud over CalDAV.
 *
 * The one provider that can write. A subscribed .ics link is a published file and there is
 * nothing to push back to it; CalDAV is a real protocol with addressable resources, so an
 * appointment can be created, moved and deleted from here.
 *
 * ── What CalDAV actually is ──────────────────────────────────────────────────────────────
 * WebDAV with two extra verbs' worth of XML on top. Four things happen:
 *
 *   1. **Discovery.** You do not know your own calendar URL. `PROPFIND` for
 *      `current-user-principal` gets you your principal; a second `PROPFIND` on that gets
 *      `calendar-home-set`, the collection your calendars live in.
 *   2. **Listing.** `PROPFIND Depth: 1` on the home, keeping the children whose
 *      `resourcetype` contains `calendar` — the home also contains inbox, outbox and
 *      notification collections that are not calendars.
 *   3. **Reading.** A `calendar-query` REPORT with a time range, which returns one response
 *      per event carrying its `getetag` and its whole iCalendar body.
 *   4. **Writing.** `PUT` an iCalendar body to a URL you choose. The etag is the
 *      concurrency control: `If-None-Match: *` means "only if it does not exist yet" and
 *      `If-Match: <etag>` means "only if nobody else changed it since I read it". Skipping
 *      those is how a sync client silently overwrites something edited on the phone.
 *
 * ── iCloud's own habits ──────────────────────────────────────────────────────────────────
 * Apple shards accounts across partition hosts. The first request to `caldav.icloud.com`
 * answers with a redirect or an absolute href on `pNN-caldav.icloud.com`, and every later
 * request has to go there. `fetch` will not follow a redirect for `PROPFIND` usefully, so
 * redirects are followed by hand and the resolved origin is remembered.
 *
 * Authentication is Basic with an **app-specific password**. An Apple ID password will not
 * work and neither will anything interactive: Apple's account authorisation is not usable
 * from a desktop app on Windows, which is why the credential is a generated one.
 */

import { parseIcs, type ParsedEvent } from './ics-parse.js'
import { decodeEntities, elements, escapeXml, parseMultistatus } from './dav-xml.js'
import { writeCalendar } from './ics-write.js'
import {
  UnsupportedOperationError,
  type CalendarProvider,
  type ProviderCalendar,
  type ProviderEvents
} from './provider.js'

const DEFAULT_ORIGIN = 'https://caldav.icloud.com'
const TIMEOUT_MS = 30_000
/** Apple shards accounts; a handful of hops is normal, an endless chain is a bug. */
const MAX_REDIRECTS = 5

const XML_HEADERS = {
  'Content-Type': 'application/xml; charset=utf-8',
  Accept: 'application/xml, text/xml'
}

/**
 * Apple is picky about this in a way the spec never mentions: a request without a
 * recognisable User-Agent can come back empty or refused rather than with a useful error.
 */
const USER_AGENT = 'Uurwerk/0.1 (CalDAV)'

/**
 * A response snippet safe to show in an error.
 *
 * Discovery failures are unreproducible without the account they failed on, so the message
 * has to carry enough to diagnose from. Credentials only ever travel in the Authorization
 * header, never in a body, so echoing a trimmed body leaks nothing — but it is trimmed hard
 * anyway, because an error dialog is not a log viewer.
 */
function snippet(text: string, limit = 1200): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/** '20260822T090000Z' — the form a time-range filter wants. */
const stamp = (ms: number): string =>
  `${new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`

export interface CalDavCredentials {
  /** The Apple ID the calendars belong to. */
  username: string
  /** An app-specific password. The account password is rejected by design. */
  appPassword: string
}

export class CalDavProvider implements CalendarProvider {
  readonly id = 'icloud' as const
  // Incremental sync via sync-collection exists, but etag comparison on a bounded window is
  // enough here and has one fewer failure mode. Claiming it would stop `markMissingAsDeleted`
  // running, which is what notices an event deleted on the phone.
  readonly capabilities = { read: true, write: true, incrementalSync: false }

  /** Learned during discovery and reused: Apple's partition host for this account. */
  private origin = DEFAULT_ORIGIN
  private principal: string | null = null
  private home: string | null = null

  constructor(private readonly credentials: CalDavCredentials) {}

  // ------------------------------------------------------------------ plumbing

  private get authorization(): string {
    const raw = `${this.credentials.username}:${this.credentials.appPassword}`
    return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`
  }

  /** Resolves an href, which may be absolute or a path, against the current origin. */
  private absolute(href: string): string {
    if (/^https?:\/\//i.test(href)) return href
    return new URL(href, this.origin).toString()
  }

  /**
   * One request, with redirects followed by hand.
   *
   * `fetch` turns a 301/302 into a GET for anything that is not idempotent, which loses the
   * method and the body — fatal for PROPFIND and REPORT, both of which are POST-shaped. So
   * redirects are handled here, preserving method and body, and the new origin is kept.
   */
  private async request(
    method: string,
    url: string,
    options: { body?: string; headers?: Record<string, string>; depth?: string } = {}
  ): Promise<{ status: number; text: string; etag: string | null; url: string }> {
    let target = this.absolute(url)

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

      try {
        const response = await fetch(target, {
          method,
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            Authorization: this.authorization,
            'User-Agent': USER_AGENT,
            ...(options.depth !== undefined ? { Depth: options.depth } : {}),
            ...(options.body !== undefined ? XML_HEADERS : {}),
            ...options.headers
          },
          ...(options.body !== undefined ? { body: options.body } : {})
        })

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location')
          if (!location) break
          target = new URL(location, target).toString()
          // Remember the partition host so later requests skip the hop.
          this.origin = new URL(target).origin
          continue
        }

        if (response.status === 401 || response.status === 403) {
          throw new Error(
            'iCloud rejected the sign-in. Check the Apple ID, and make sure the password is ' +
              'an app-specific password rather than your account password.'
          )
        }

        return {
          status: response.status,
          text: await response.text(),
          etag: response.headers.get('etag'),
          url: target
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(`iCloud did not respond within ${TIMEOUT_MS / 1000} seconds.`)
        }
        throw error
      } finally {
        clearTimeout(timer)
      }
    }

    throw new Error('iCloud redirected too many times. Try again later.')
  }

  private async propfind(url: string, body: string, depth: '0' | '1'): Promise<string> {
    const { status, text } = await this.request('PROPFIND', url, { body, depth })
    if (status !== 207 && status !== 200) {
      throw new Error(`iCloud answered ${status} when reading the calendar list.`)
    }
    return text
  }

  // ----------------------------------------------------------------- discovery

  /**
   * Finds the principal and the calendar home, and proves the credential works.
   *
   * Deliberately slow and loud: this is the moment the password is checked, and a connect
   * that reports success while finding nothing is the worst possible outcome for whoever
   * has to work out why their calendar is empty.
   */
  async connect(): Promise<{ displayName: string; accountIdentifier: string | null }> {
    const principalBody =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`

    /**
     * Two entry points, tried in order.
     *
     * RFC 6764 says a client should start at `/.well-known/caldav`; Apple also answers on
     * the root, and which one behaves depends on how the account was provisioned. Trying
     * both costs one extra request on the unlucky path and removes a whole class of "it
     * works for everyone except you".
     */
    const attempts: Array<{ url: string; status: number; body: string }> = []
    let principalHref: string | null = null

    for (const path of ['/', '/.well-known/caldav']) {
      const url = `${DEFAULT_ORIGIN}${path}`
      const { status, text } = await this.request('PROPFIND', url, {
        body: principalBody,
        depth: '0'
      })
      attempts.push({ url, status, body: text })

      if (status === 207 || status === 200) {
        principalHref = firstHrefIn(text, 'current-user-principal')
        if (principalHref) break
      }
    }

    if (!principalHref) {
      // Unreproducible without the account, so the message carries what Apple actually said.
      const detail = attempts
        .map((attempt) => `${attempt.url} → ${attempt.status}: ${snippet(attempt.body, 200)}`)
        .join(' | ')
      throw new Error(`iCloud did not return an account for that Apple ID. ${detail}`)
    }

    this.principal = this.absolute(principalHref)

    const homeBody =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<d:propfind xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">` +
      `<d:prop><cal:calendar-home-set/><d:displayname/></d:prop></d:propfind>`

    const homeXml = await this.propfind(this.principal, homeBody, '0')
    const homeHref = firstHrefIn(homeXml, 'calendar-home-set')
    if (!homeHref) {
      throw new Error(
        `iCloud did not say where the calendars live. ${this.principal} → ${snippet(homeXml, 200)}`
      )
    }
    this.home = this.absolute(homeHref)

    const [named] = parseMultistatus(homeXml, ['displayname'])
    return {
      displayName: named?.props['displayname'] || 'iCloud',
      accountIdentifier: this.credentials.username
    }
  }

  async disconnect(): Promise<void> {
    // Nothing to revoke from here. The credential is an app-specific password, and it is
    // revoked from the Apple account page — forgetting it locally is all this can do.
  }

  private async requireHome(): Promise<string> {
    if (!this.home) await this.connect()
    if (!this.home) throw new Error('Not connected to iCloud.')
    return this.home
  }

  // ----------------------------------------------------------------- calendars

  async getCalendars(): Promise<ProviderCalendar[]> {
    const home = await this.requireHome()
    const body =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">` +
      `<d:prop><d:displayname/><d:resourcetype/><cs:getctag/><d:current-user-privilege-set/>` +
      `</d:prop></d:propfind>`

    const xml = await this.propfind(home, body, '1')

    return parseMultistatus(xml, ['displayname', 'getctag'])
      // The home also holds inbox, outbox and notification collections. Only the ones
      // marked as calendars are calendars.
      .filter((response) => response.flags.includes('calendar'))
      .map((response) => ({
        externalId: this.absolute(response.href),
        name: response.props['displayname'] || 'Untitled calendar',
        writable: true
      }))
  }

  /**
   * Creates a calendar this app owns outright.
   *
   * The whole safety argument for two-way sync rests on this: Uurwerk writes only to a
   * collection it made, so it can rewrite that collection freely on every replan while your
   * own calendars stay read-only and untouched.
   */
  async createCalendar(name: string): Promise<ProviderCalendar> {
    const home = await this.requireHome()
    // A stable, unguessable-enough path segment; the display name is what you actually see.
    const url = new URL(`uurwerk-${Date.now().toString(36)}/`, home).toString()

    const body =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<cal:mkcalendar xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">` +
      `<d:set><d:prop><d:displayname>${escapeXml(name)}</d:displayname>` +
      `<cal:supported-calendar-component-set><cal:comp name="VEVENT"/>` +
      `</cal:supported-calendar-component-set></d:prop></d:set></cal:mkcalendar>`

    const { status } = await this.request('MKCALENDAR', url, { body })
    if (status !== 201 && status !== 200) {
      throw new Error(`iCloud refused to create the calendar (${status}).`)
    }

    return { externalId: url, name, writable: true }
  }

  // -------------------------------------------------------------------- events

  async getEvents(fromMs: number, toMs: number): Promise<ProviderEvents> {
    const calendars = await this.getCalendars()
    const events: ParsedEvent[] = []
    for (const calendar of calendars) {
      events.push(...(await this.eventsIn(calendar.externalId, fromMs, toMs)))
    }
    return { events, syncToken: null }
  }

  /** One calendar's events in a window, which is what the sync loop actually wants. */
  async eventsIn(calendarUrl: string, fromMs: number, toMs: number): Promise<ParsedEvent[]> {
    const body =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<cal:calendar-query xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">` +
      `<d:prop><d:getetag/><cal:calendar-data/></d:prop>` +
      `<cal:filter><cal:comp-filter name="VCALENDAR">` +
      `<cal:comp-filter name="VEVENT">` +
      `<cal:time-range start="${stamp(fromMs)}" end="${stamp(toMs)}"/>` +
      `</cal:comp-filter></cal:comp-filter></cal:filter></cal:calendar-query>`

    const { status, text } = await this.request('REPORT', calendarUrl, { body, depth: '1' })
    if (status !== 207 && status !== 200) {
      throw new Error(`iCloud answered ${status} when reading events.`)
    }

    const out: ParsedEvent[] = []
    for (const response of parseMultistatus(text, ['getetag', 'calendar-data'])) {
      const data = response.props['calendar-data']
      if (!data) continue
      // One resource can legitimately hold a recurring master plus its overrides.
      out.push(...parseIcs(data).events)
    }
    return out
  }

  /** The URL a given event lives at inside a calendar. Deterministic, so updates find it. */
  private resourceUrl(calendarUrl: string, uid: string): string {
    return new URL(`${encodeURIComponent(uid)}.ics`, ensureSlash(calendarUrl)).toString()
  }

  async createEvent(
    calendarExternalId: string,
    event: ParsedEvent
  ): Promise<{ externalId: string; etag: string | null }> {
    const url = this.resourceUrl(calendarExternalId, event.uid)
    const { status, etag } = await this.request('PUT', url, {
      body: writeCalendar(event),
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        // Refuses rather than overwrites if something is already there.
        'If-None-Match': '*'
      }
    })

    if (status !== 201 && status !== 204 && status !== 200) {
      throw new Error(`iCloud refused to create the event (${status}).`)
    }
    return { externalId: url, etag }
  }

  async updateEvent(
    calendarExternalId: string,
    externalId: string,
    event: ParsedEvent,
    etag?: string | null
  ): Promise<{ etag: string | null }> {
    const url = externalId.startsWith('http')
      ? externalId
      : this.resourceUrl(calendarExternalId, externalId)

    const { status, etag: next } = await this.request('PUT', url, {
      body: writeCalendar(event),
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        // The concurrency guard: refuse if it changed since we read it. Without an etag we
        // have no basis for that claim, so the write is unconditional and says so.
        ...(etag ? { 'If-Match': etag } : {})
      }
    })

    if (status === 412) {
      throw new Error('That appointment changed on iCloud since it was last read.')
    }
    if (status !== 204 && status !== 200 && status !== 201) {
      throw new Error(`iCloud refused to update the event (${status}).`)
    }
    return { etag: next }
  }

  async deleteEvent(
    calendarExternalId: string,
    externalId: string,
    etag?: string | null
  ): Promise<void> {
    const url = externalId.startsWith('http')
      ? externalId
      : this.resourceUrl(calendarExternalId, externalId)

    const { status } = await this.request('DELETE', url, {
      headers: { ...(etag ? { 'If-Match': etag } : {}) }
    })

    // 404 is success for a delete: the thing is gone, which is what was asked for.
    if (status !== 204 && status !== 200 && status !== 404) {
      throw new Error(`iCloud refused to delete the event (${status}).`)
    }
  }
}

/**
 * The href a discovery property points at, from anywhere in the document.
 *
 * CalDAV nests the href it means *inside* the property rather than beside it, so the
 * response's own href is never the answer.
 *
 * Scans every occurrence rather than reading the first `<response>`, which is what broke
 * against the real iCloud. A multistatus legitimately carries several responses, and a
 * server may answer for a collection it has no principal for with an empty
 * `<current-user-principal/>` before answering properly further down. Taking the first
 * response and giving up made that look like "no account for that Apple ID" — a confident,
 * wrong, and completely undiagnosable message.
 *
 * Empty occurrences are skipped instead of ending the search, so the first *usable* href
 * wins. Nothing here needs the propstat status: an href that is present is the answer, and
 * one reported as 404 has no href to find in the first place.
 */
export function firstHrefIn(xml: string, property: string): string | null {
  for (const raw of elements(xml, property)) {
    // `elements` rather than a regex written here: iCloud repeats the namespace as an
    // attribute on every element — `<href xmlns="DAV:">` — and a pattern that only allows
    // `<href>` matches nothing at all. That is the entire difference between "connected"
    // and "no account for that Apple ID", and it is exactly what the shared helper is
    // already tested for. Two places parsing XML, one of them by hand, is the bug.
    for (const href of elements(raw, 'href')) {
      const value = decodeEntities(href).trim()
      if (value) return value
    }
  }
  return null
}

const ensureSlash = (url: string): string => (url.endsWith('/') ? url : `${url}/`)

export { UnsupportedOperationError }
