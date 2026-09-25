/**
 * Reading an iCalendar (.ics) file.
 *
 * Hand-written rather than a library, for two reasons: it keeps the runtime dependency
 * count where it is, and the subset that a published calendar actually contains is small
 * and stable. Everything here is pure text in, plain objects out — no network, no Electron,
 * no database — so it can be tested against real files.
 *
 * The format is older than it looks and has three habits worth knowing about:
 *
 *   1. **Folding.** Long lines are wrapped at 75 octets and continued with a leading space
 *      or tab. Unfolding has to happen before anything else is read, or a title splits in
 *      half mid-word.
 *   2. **Parameters.** A property is `NAME;PARAM=VALUE:content`, and the colon that ends the
 *      name can be preceded by quoted parameters containing their own colons.
 *   3. **Escaping.** Commas, semicolons, backslashes and newlines are escaped in text
 *      values, so a description arrives full of `\n` unless it is unescaped.
 *
 * ── The timezone compromise, stated plainly ──────────────────────────────────────────────
 * A UTC timestamp (`…Z`) is exact. A date-only value is a whole local day. A timestamp with
 * a `TZID` is read as **local wall time**, which is correct while the calendar and this
 * machine share a timezone and wrong by the offset when they do not. Doing better means
 * carrying a timezone database, and the alternative — guessing UTC — is wrong for everyone
 * rather than wrong for travellers.
 */

export interface ParsedEvent {
  /** The provider's own identifier. What makes re-importing an update, not a duplicate. */
  uid: string
  summary: string
  description: string | null
  location: string | null
  startsAt: number
  endsAt: number
  allDay: boolean
  /** Raw RRULE, kept verbatim: expansion happens elsewhere, and only for display. */
  recurrenceRule: string | null
  /** Set on one occurrence of a series that was moved or cancelled by itself. */
  recurrenceId: number | null
  cancelled: boolean
  organizer: string | null
  attendees: string[]
  /** The provider's last-modified stamp, for conflict resolution. */
  updatedAt: number | null
}

export interface ParsedCalendar {
  /** X-WR-CALNAME when the publisher bothered to set it. */
  name: string | null
  events: ParsedEvent[]
}

interface Property {
  name: string
  params: Record<string, string>
  value: string
}

/** Undoes the 75-octet line folding. Must run before anything else reads a line. */
function unfold(text: string): string[] {
  const lines: string[] = []

  for (const raw of text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && lines.length > 0) {
      lines[lines.length - 1] += raw.slice(1)
    } else {
      lines.push(raw)
    }
  }

  return lines.filter((line) => line.trim().length > 0)
}

/**
 * Splits `NAME;PARAM="a:b":value` into its parts.
 *
 * The quoted-parameter case is why this cannot be a `split(':')` — a parameter is allowed
 * to contain the very character that ends the property name.
 */
function parseLine(line: string): Property | null {
  let inQuotes = false
  let colon = -1

  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (char === '"') inQuotes = !inQuotes
    else if (char === ':' && !inQuotes) {
      colon = index
      break
    }
  }
  if (colon === -1) return null

  const head = line.slice(0, colon)
  const value = line.slice(colon + 1)
  const [name, ...paramParts] = head.split(';')

  const params: Record<string, string> = {}
  for (const part of paramParts) {
    const equals = part.indexOf('=')
    if (equals === -1) continue
    params[part.slice(0, equals).toUpperCase()] = part.slice(equals + 1).replace(/^"|"$/g, '')
  }

  return { name: (name ?? '').toUpperCase(), params, value }
}

/** `\n` `\,` `\;` `\\` back to the characters they stand for. */
const unescapeText = (value: string): string =>
  value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')

/**
 * A date-time in one of the three shapes a calendar uses.
 *
 * Returns null for anything unrecognised rather than guessing — an event with an
 * unparseable start is dropped, which is visibly wrong, where a guessed one is invisibly so.
 */
function parseDateTime(property: Property): { at: number; allDay: boolean } | null {
  const value = property.value.trim()

  // A whole day: 20260818
  if (property.params['VALUE'] === 'DATE' || /^\d{8}$/.test(value)) {
    const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value)
    if (!match) return null
    const [, year, month, day] = match
    return { at: new Date(Number(year), Number(month) - 1, Number(day)).getTime(), allDay: true }
  }

  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(value)
  if (!match) return null

  const [, year, month, day, hour, minute, second, zulu] = match
  const parts = [Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)] as const

  // Z is absolute; anything else is read as local wall time — see the header note.
  const at = zulu
    ? Date.UTC(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5])
    : new Date(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]).getTime()

  return { at, allDay: false }
}

/** `DURATION:PT1H30M` — used when an event gives a length instead of an end. */
function parseDuration(value: string): number | null {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim())
  if (!match) return null

  const [, days, hours, minutes, seconds] = match
  const total =
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0)

  return total > 0 ? total * 1000 : null
}

const stripMailto = (value: string): string => value.replace(/^mailto:/i, '').trim()

export function parseIcs(text: string): ParsedCalendar {
  const lines = unfold(text)
  const events: ParsedEvent[] = []

  let name: string | null = null
  let current: Partial<ParsedEvent> & { attendees: string[]; durationMs?: number } | null = null

  for (const line of lines) {
    const property = parseLine(line)
    if (!property) continue

    if (property.name === 'BEGIN' && property.value === 'VEVENT') {
      current = { attendees: [] }
      continue
    }

    if (property.name === 'END' && property.value === 'VEVENT') {
      if (current?.uid && current.summary !== undefined && current.startsAt !== undefined) {
        // An event with no end is an hour long by convention; a whole-day one is a day.
        const fallback = current.allDay ? 86_400_000 : 3_600_000
        const endsAt =
          current.endsAt ?? current.startsAt + (current.durationMs ?? fallback)

        events.push({
          uid: current.uid,
          summary: current.summary || '(no title)',
          description: current.description ?? null,
          location: current.location ?? null,
          startsAt: current.startsAt,
          endsAt: Math.max(endsAt, current.startsAt + 60_000),
          allDay: current.allDay ?? false,
          recurrenceRule: current.recurrenceRule ?? null,
          recurrenceId: current.recurrenceId ?? null,
          cancelled: current.cancelled ?? false,
          organizer: current.organizer ?? null,
          attendees: current.attendees,
          updatedAt: current.updatedAt ?? null
        })
      }
      current = null
      continue
    }

    if (!current) {
      if (property.name === 'X-WR-CALNAME') name = unescapeText(property.value)
      continue
    }

    switch (property.name) {
      case 'UID':
        current.uid = property.value.trim()
        break
      case 'SUMMARY':
        current.summary = unescapeText(property.value)
        break
      case 'DESCRIPTION':
        current.description = unescapeText(property.value)
        break
      case 'LOCATION':
        current.location = unescapeText(property.value)
        break
      case 'DTSTART': {
        const parsed = parseDateTime(property)
        if (parsed) {
          current.startsAt = parsed.at
          current.allDay = parsed.allDay
        }
        break
      }
      case 'DTEND': {
        const parsed = parseDateTime(property)
        if (parsed) current.endsAt = parsed.at
        break
      }
      case 'DURATION': {
        const ms = parseDuration(property.value)
        if (ms) current.durationMs = ms
        break
      }
      case 'RRULE':
        current.recurrenceRule = property.value.trim()
        break
      case 'RECURRENCE-ID': {
        const parsed = parseDateTime(property)
        if (parsed) current.recurrenceId = parsed.at
        break
      }
      case 'STATUS':
        current.cancelled = property.value.trim().toUpperCase() === 'CANCELLED'
        break
      case 'ORGANIZER':
        current.organizer = property.params['CN'] ?? stripMailto(property.value)
        break
      case 'ATTENDEE': {
        const attendee = property.params['CN'] ?? stripMailto(property.value)
        if (attendee) current.attendees.push(attendee)
        break
      }
      case 'LAST-MODIFIED':
      case 'DTSTAMP': {
        // LAST-MODIFIED wins when both are present; DTSTAMP is only a fallback.
        const parsed = parseDateTime(property)
        if (parsed && (property.name === 'LAST-MODIFIED' || current.updatedAt === undefined)) {
          current.updatedAt = parsed.at
        }
        break
      }
      default:
        break
    }
  }

  return { name, events }
}
