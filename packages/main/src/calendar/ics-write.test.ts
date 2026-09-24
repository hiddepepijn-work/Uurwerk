/**
 * Writing iCalendar, checked by reading it back.
 *
 * The parser is the only honest judge of the writer: a body that looks right and does not
 * survive a round trip is a corrupt appointment on somebody's phone. So most of these write
 * an event, parse it, and compare — the two halves keep each other straight.
 */

import { describe, expect, it } from 'vitest'
import { parseIcs, type ParsedEvent } from './ics-parse.js'
import { escapeText, fold, toDateStamp, toUtcStamp, writeCalendar } from './ics-write.js'

const event = (overrides: Partial<ParsedEvent> = {}): ParsedEvent => ({
  uid: 'uurwerk-1@uurwerk.app',
  summary: 'Projectoverleg Maasarend',
  description: null,
  location: null,
  startsAt: Date.parse('2026-08-22T09:00:00Z'),
  endsAt: Date.parse('2026-08-22T10:00:00Z'),
  allDay: false,
  recurrenceRule: null,
  recurrenceId: null,
  cancelled: false,
  organizer: null,
  attendees: [],
  updatedAt: null,
  ...overrides
})

/** Write it, read it back, hand back the single event. */
const roundTrip = (input: ParsedEvent): ParsedEvent => {
  const parsed = parseIcs(writeCalendar(input))
  expect(parsed.events).toHaveLength(1)
  return parsed.events[0]!
}

describe('the shape of the body', () => {
  it('is a VCALENDAR holding exactly one VEVENT', () => {
    const text = writeCalendar(event())
    expect(text).toContain('BEGIN:VCALENDAR')
    expect(text).toContain('BEGIN:VEVENT')
    expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(1)
    expect(text.trimEnd().endsWith('END:VCALENDAR')).toBe(true)
  })

  it('separates every line with CRLF, which is the one thing servers are strict about', () => {
    const text = writeCalendar(event())
    expect(text).toContain('\r\n')
    // No bare newline anywhere: every \n must be preceded by \r.
    expect(/[^\r]\n/.test(text)).toBe(false)
  })

  it('says who wrote it, so Uurwerk can recognise its own rows', () => {
    expect(writeCalendar(event())).toContain('PRODID:-//Uurwerk//Time tracker//EN')
  })
})

describe('round trips', () => {
  it('keeps the title, the times and the identity', () => {
    const original = event()
    const back = roundTrip(original)

    expect(back.uid).toBe(original.uid)
    expect(back.summary).toBe(original.summary)
    expect(back.startsAt).toBe(original.startsAt)
    expect(back.endsAt).toBe(original.endsAt)
  })

  it('survives the characters the format reserves', () => {
    const back = roundTrip(
      event({
        summary: 'Overleg: planning, budget; fase 2',
        description: 'Twee regels\nen een backslash \\ erin',
        location: 'Zaal 1, gebouw B'
      })
    )

    expect(back.summary).toBe('Overleg: planning, budget; fase 2')
    expect(back.description).toBe('Twee regels\nen een backslash \\ erin')
    expect(back.location).toBe('Zaal 1, gebouw B')
  })

  it('survives a title long enough to be folded', () => {
    const long = 'Afmaken hoofdstuk zeven inclusief resultaten discussie en conclusie herzien'
    const back = roundTrip(event({ summary: long }))
    expect(back.summary).toBe(long)
  })

  it('survives accents, which is where a byte-counting fold earns its keep', () => {
    const accented = `Réunion prioritaire ${'é'.repeat(60)} fin`
    const back = roundTrip(event({ summary: accented }))
    expect(back.summary).toBe(accented)
  })

  it('carries a cancellation through', () => {
    expect(roundTrip(event({ cancelled: true })).cancelled).toBe(true)
    expect(roundTrip(event({ cancelled: false })).cancelled).toBe(false)
  })

  it('keeps a recurrence rule verbatim', () => {
    const back = roundTrip(event({ recurrenceRule: 'FREQ=WEEKLY;BYDAY=TU' }))
    expect(back.recurrenceRule).toBe('FREQ=WEEKLY;BYDAY=TU')
  })

  it('keeps an all-day event a whole day rather than a moment', () => {
    const back = roundTrip(
      event({
        allDay: true,
        startsAt: Date.parse('2026-08-22T00:00:00'),
        endsAt: Date.parse('2026-08-23T00:00:00')
      })
    )
    expect(back.allDay).toBe(true)
  })
})

describe('the primitives', () => {
  it('writes a UTC instant, not local wall time', () => {
    expect(toUtcStamp(Date.parse('2026-08-22T09:00:00Z'))).toBe('20260822T090000Z')
  })

  it('writes a date-only value from the local day', () => {
    expect(toDateStamp(Date.parse('2026-08-22T12:00:00'))).toBe('20260822')
  })

  it('escapes the backslash first, so it does not escape its own escapes', () => {
    expect(escapeText('a\\b;c,d')).toBe('a\\\\b\\;c\\,d')
  })

  it('leaves a colon alone — legal in a value, and ugly everywhere if escaped', () => {
    expect(escapeText('Overleg: fase 2')).toBe('Overleg: fase 2')
  })

  it('folds to 75 octets with a single leading space on each continuation', () => {
    const folded = fold(`SUMMARY:${'x'.repeat(200)}`)
    const parts = folded.split('\r\n')

    expect(parts.length).toBeGreaterThan(1)
    expect(Buffer.byteLength(parts[0]!, 'utf8')).toBeLessThanOrEqual(75)
    for (const part of parts.slice(1)) {
      expect(part.startsWith(' ')).toBe(true)
      expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(75)
    }
  })

  it('never splits a multi-byte character across a fold', () => {
    const folded = fold(`SUMMARY:${'é'.repeat(120)}`)
    for (const part of folded.split('\r\n')) {
      expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(75)
      // A split inside a sequence would leave a replacement character behind.
      expect(part).not.toContain('�')
    }
  })

  it('leaves a short line alone', () => {
    expect(fold('SUMMARY:Short')).toBe('SUMMARY:Short')
  })
})
