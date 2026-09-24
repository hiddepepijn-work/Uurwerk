import { describe, expect, it } from 'vitest'
import { parseIcs } from './ics-parse.js'

/** A calendar file, written the way real ones arrive: CRLF line endings. */
const ics = (...lines: string[]): string =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR'].join('\r\n')

const event = (...lines: string[]): string => ics('BEGIN:VEVENT', ...lines, 'END:VEVENT')

describe('the basics', () => {
  it('reads a plain appointment', () => {
    const { events } = parseIcs(
      event(
        'UID:abc-123',
        'SUMMARY:Projectoverleg Maasarend',
        'LOCATION:Teams',
        'DTSTART:20260818T090000Z',
        'DTEND:20260818T100000Z'
      )
    )

    expect(events).toHaveLength(1)
    expect(events[0]!.uid).toBe('abc-123')
    expect(events[0]!.summary).toBe('Projectoverleg Maasarend')
    expect(events[0]!.location).toBe('Teams')
    expect(events[0]!.endsAt - events[0]!.startsAt).toBe(60 * 60 * 1000)
  })

  it('picks up the calendar name when the publisher set one', () => {
    expect(parseIcs(ics('X-WR-CALNAME:Hidde — HAS')).name).toBe('Hidde — HAS')
  })

  it('reads several events from one file', () => {
    const file = ics(
      'BEGIN:VEVENT',
      'UID:one',
      'SUMMARY:First',
      'DTSTART:20260818T090000Z',
      'DTEND:20260818T100000Z',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:two',
      'SUMMARY:Second',
      'DTSTART:20260819T090000Z',
      'DTEND:20260819T100000Z',
      'END:VEVENT'
    )

    expect(parseIcs(file).events.map((entry) => entry.uid)).toEqual(['one', 'two'])
  })
})

describe('the awkward parts of the format', () => {
  it('unfolds a title that was wrapped mid-word', () => {
    // 75 octets and the rest continues with a leading space.
    const { events } = parseIcs(
      event(
        'UID:folded',
        'SUMMARY:Projectoverleg over de nieuwe kaartlaag en de bijbehorende ',
        ' documentatie',
        'DTSTART:20260818T090000Z',
        'DTEND:20260818T100000Z'
      )
    )

    expect(events[0]!.summary).toBe(
      'Projectoverleg over de nieuwe kaartlaag en de bijbehorende documentatie'
    )
  })

  it('unescapes commas, semicolons and newlines', () => {
    const { events } = parseIcs(
      event(
        'UID:escaped',
        'SUMMARY:Overleg\\, deel 2',
        'DESCRIPTION:Eerste regel\\nTweede regel\\; met puntkomma',
        'DTSTART:20260818T090000Z',
        'DTEND:20260818T100000Z'
      )
    )

    expect(events[0]!.summary).toBe('Overleg, deel 2')
    expect(events[0]!.description).toBe('Eerste regel\nTweede regel; met puntkomma')
  })

  it('survives a quoted parameter containing a colon', () => {
    const { events } = parseIcs(
      event(
        'UID:quoted',
        'ORGANIZER;CN="Margriet: begeleider":mailto:margriet@example.com',
        'SUMMARY:Overleg',
        'DTSTART:20260818T090000Z',
        'DTEND:20260818T100000Z'
      )
    )

    expect(events[0]!.organizer).toBe('Margriet: begeleider')
    expect(events[0]!.summary).toBe('Overleg')
  })

  it('collects every attendee', () => {
    const { events } = parseIcs(
      event(
        'UID:people',
        'SUMMARY:Overleg',
        'ATTENDEE;CN=Margriet:mailto:margriet@example.com',
        'ATTENDEE:mailto:jan@example.com',
        'DTSTART:20260818T090000Z',
        'DTEND:20260818T100000Z'
      )
    )

    expect(events[0]!.attendees).toEqual(['Margriet', 'jan@example.com'])
  })
})

describe('dates and times', () => {
  it('treats a Z timestamp as absolute', () => {
    const { events } = parseIcs(
      event('UID:utc', 'SUMMARY:X', 'DTSTART:20260818T090000Z', 'DTEND:20260818T100000Z')
    )

    expect(events[0]!.startsAt).toBe(Date.UTC(2026, 7, 18, 9, 0, 0))
  })

  it('reads a date-only event as a whole local day', () => {
    const { events } = parseIcs(
      event('UID:allday', 'SUMMARY:Vrije dag', 'DTSTART;VALUE=DATE:20260818', 'DTEND;VALUE=DATE:20260819')
    )

    expect(events[0]!.allDay).toBe(true)
    expect(events[0]!.startsAt).toBe(new Date(2026, 7, 18).getTime())
  })

  it('reads a TZID timestamp as local wall time', () => {
    // The documented compromise: right while the calendar and this machine agree.
    const { events } = parseIcs(
      event(
        'UID:tz',
        'SUMMARY:X',
        'DTSTART;TZID=Europe/Amsterdam:20260818T090000',
        'DTEND;TZID=Europe/Amsterdam:20260818T100000'
      )
    )

    expect(events[0]!.startsAt).toBe(new Date(2026, 7, 18, 9, 0, 0).getTime())
  })

  it('accepts a duration instead of an end', () => {
    const { events } = parseIcs(
      event('UID:dur', 'SUMMARY:X', 'DTSTART:20260818T090000Z', 'DURATION:PT1H30M')
    )

    expect(events[0]!.endsAt - events[0]!.startsAt).toBe(90 * 60 * 1000)
  })

  it('gives an event with no end an hour, rather than dropping it', () => {
    const { events } = parseIcs(event('UID:noend', 'SUMMARY:X', 'DTSTART:20260818T090000Z'))
    expect(events[0]!.endsAt - events[0]!.startsAt).toBe(60 * 60 * 1000)
  })

  it('drops an event whose start cannot be read rather than guessing one', () => {
    expect(parseIcs(event('UID:broken', 'SUMMARY:X', 'DTSTART:not-a-date')).events).toEqual([])
  })
})

describe('recurrence and cancellation', () => {
  it('keeps the rule verbatim', () => {
    const { events } = parseIcs(
      event(
        'UID:weekly',
        'SUMMARY:Weekoverleg',
        'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=10',
        'DTSTART:20260818T090000Z',
        'DTEND:20260818T100000Z'
      )
    )

    expect(events[0]!.recurrenceRule).toBe('FREQ=WEEKLY;BYDAY=TU;COUNT=10')
  })

  it('marks a single cancelled occurrence, with the date it replaces', () => {
    const { events } = parseIcs(
      event(
        'UID:weekly',
        'SUMMARY:Weekoverleg',
        'RECURRENCE-ID:20260825T090000Z',
        'STATUS:CANCELLED',
        'DTSTART:20260825T090000Z',
        'DTEND:20260825T100000Z'
      )
    )

    expect(events[0]!.cancelled).toBe(true)
    expect(events[0]!.recurrenceId).toBe(Date.UTC(2026, 7, 25, 9, 0, 0))
  })

  it('prefers LAST-MODIFIED over DTSTAMP for the update time', () => {
    const { events } = parseIcs(
      event(
        'UID:stamped',
        'SUMMARY:X',
        'DTSTAMP:20260801T120000Z',
        'LAST-MODIFIED:20260810T080000Z',
        'DTSTART:20260818T090000Z',
        'DTEND:20260818T100000Z'
      )
    )

    expect(events[0]!.updatedAt).toBe(Date.UTC(2026, 7, 10, 8, 0, 0))
  })
})

describe('files that are not quite right', () => {
  it('ignores an event with no UID, which cannot be synced anyway', () => {
    expect(parseIcs(event('SUMMARY:Anonymous', 'DTSTART:20260818T090000Z')).events).toEqual([])
  })

  it('gives a nameless event a placeholder rather than an empty row', () => {
    const { events } = parseIcs(event('UID:blank', 'SUMMARY:', 'DTSTART:20260818T090000Z'))
    expect(events[0]!.summary).toBe('(no title)')
  })

  it('reads an empty calendar without complaining', () => {
    expect(parseIcs(ics()).events).toEqual([])
    expect(parseIcs('').events).toEqual([])
  })
})
