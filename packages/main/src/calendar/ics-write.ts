/**
 * Writing an iCalendar (.ics) body.
 *
 * The mirror of `ics-parse.ts`, and hand-written for the same reasons: no new runtime
 * dependency, and the subset a calendar server actually needs is small. Pure data in, text
 * out — no network, no Electron, no database — so it is testable against the parser.
 *
 * The three habits from the parser all have to be honoured in reverse:
 *
 *   1. **Escaping first, folding second.** Escaping inserts characters, so folding before it
 *      would produce lines longer than 75 octets after the fact.
 *   2. **Folding counts octets, not characters.** A line split in the middle of a multi-byte
 *      sequence is corrupt, so the fold walks code points and measures their UTF-8 length.
 *   3. **CRLF, always.** RFC 5545 says so, and CalDAV servers are the one audience strict
 *      enough to reject bare newlines.
 *
 * Times go out as UTC (`…Z`). The parser's timezone compromise reads `TZID` as local wall
 * time; writing UTC sidesteps it entirely, because a UTC instant means the same thing to
 * every reader and needs no timezone database to interpret.
 */

import type { ParsedEvent } from './ics-parse.js'

/** What this app writes into every event it creates, so its own rows are recognisable. */
export const UURWERK_PRODID = '-//Uurwerk//Time tracker//EN'

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/** '20260822T140000Z' — a UTC instant, the only form that needs no timezone to read. */
export function toUtcStamp(ms: number): string {
  const d = new Date(ms)
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  )
}

/** '20260822' — a whole local day, which is what an all-day event actually means. */
export function toDateStamp(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

/**
 * Escapes a text value: backslash first, or it would escape the escapes it just added.
 * Colons are deliberately left alone — they are legal inside a text value, and escaping
 * them makes titles arrive full of backslashes in other calendar apps.
 */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

/**
 * Folds one logical line to 75 octets, continuing with a single leading space.
 *
 * The limit is bytes, not characters. Measuring in characters would let a line of accented
 * text exceed it, and splitting inside a multi-byte sequence would corrupt it — so this
 * walks code points and tracks their encoded width.
 */
export function fold(line: string): string {
  const LIMIT = 75
  const out: string[] = []
  let current = ''
  let width = 0

  for (const char of line) {
    const size = Buffer.byteLength(char, 'utf8')
    // Continuation lines carry a leading space, so they have one octet less to spend.
    const limit = out.length === 0 ? LIMIT : LIMIT - 1
    if (width + size > limit) {
      out.push(current)
      current = ''
      width = 0
    }
    current += char
    width += size
  }
  out.push(current)

  return out.map((part, index) => (index === 0 ? part : ` ${part}`)).join('\r\n')
}

/** One `NAME:value` property, escaped and folded. */
const line = (name: string, value: string): string => fold(`${name}:${value}`)

/**
 * One VEVENT wrapped in a VCALENDAR — the shape a CalDAV `PUT` expects.
 *
 * One event per resource, which is what a CalDAV collection is built around: the URL
 * identifies the event, so bundling several into one body makes them unaddressable.
 */
export function writeCalendar(event: ParsedEvent, now = Date.now()): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    line('PRODID', UURWERK_PRODID),
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    line('UID', event.uid),
    line('DTSTAMP', toUtcStamp(now))
  ]

  if (event.allDay) {
    // Date-only values are exclusive at the end: a one-day event ends on the next day.
    lines.push(`DTSTART;VALUE=DATE:${toDateStamp(event.startsAt)}`)
    lines.push(`DTEND;VALUE=DATE:${toDateStamp(event.endsAt)}`)
  } else {
    lines.push(line('DTSTART', toUtcStamp(event.startsAt)))
    lines.push(line('DTEND', toUtcStamp(event.endsAt)))
  }

  lines.push(line('SUMMARY', escapeText(event.summary)))
  if (event.description) lines.push(line('DESCRIPTION', escapeText(event.description)))
  if (event.location) lines.push(line('LOCATION', escapeText(event.location)))
  if (event.recurrenceRule) lines.push(line('RRULE', event.recurrenceRule))
  if (event.recurrenceId !== null) {
    lines.push(line('RECURRENCE-ID', toUtcStamp(event.recurrenceId)))
  }
  if (event.organizer) lines.push(line('ORGANIZER', event.organizer))
  for (const attendee of event.attendees) lines.push(line('ATTENDEE', attendee))
  lines.push(`STATUS:${event.cancelled ? 'CANCELLED' : 'CONFIRMED'}`)

  lines.push('END:VEVENT', 'END:VCALENDAR')

  // Trailing CRLF: some servers treat a body without one as truncated.
  return `${lines.join('\r\n')}\r\n`
}
