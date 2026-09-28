/**
 * Turning plan blocks into calendar entries.
 *
 * The pure half of the push: which blocks become events, what they look like, and when two
 * are considered the same appointment. The reconcile built on top of these decides what gets
 * deleted from a real calendar, so getting them wrong is the expensive kind of wrong.
 */

import { describe, expect, it } from 'vitest'
import type { CalendarEvent, PlanBlock } from '@core/contract/types.js'
import { appointmentEvents, eventUid, isEventUid, isPlanUid, sameAppointment, toEvent, uidFor } from './push.js'
import { parseIcs } from './ics-parse.js'
import { writeCalendar } from './ics-write.js'

const block = (overrides: Partial<PlanBlock> = {}): PlanBlock => ({
  id: 'block-1',
  planId: 'plan-1',
  taskId: 'task-1',
  taskTitle: 'Hoofdstuk 6 afmaken',
  areaId: 'stage',
  projectName: 'SDSS De Margriet',
  projectColor: null,
  date: '2026-08-24',
  startMin: 9 * 60,
  endMin: 10 * 60 + 30,
  kind: 'task',
  title: null,
  fixed: false,
  locked: false,
  source: 'planner',
  createdBy: null,
  originalBlockId: null,
  explanation: 'Due soonest.',
  score: 10,
  ...overrides
})

describe('which blocks reach the phone', () => {
  it('turns a task block into an event', () => {
    expect(toEvent(block())).not.toBeNull()
  })

  it('leaves breaks off, because a phone full of "Break" is noise', () => {
    expect(toEvent(block({ kind: 'break', title: 'Break', taskTitle: null }))).toBeNull()
  })
})

describe('what the entry says', () => {
  it('uses the task title, and the block title when there is no task', () => {
    expect(toEvent(block())!.summary).toBe('Hoofdstuk 6 afmaken')
    expect(toEvent(block({ taskTitle: null, title: 'Admin' }))!.summary).toBe('Admin')
  })

  it('never ends up with an empty title', () => {
    expect(toEvent(block({ taskTitle: null, title: null }))!.summary).toBe('Planned work')
  })

  it('places the event at the block’s local time on its own day', () => {
    const event = toEvent(block())!
    const start = new Date(event.startsAt)
    const end = new Date(event.endsAt)

    expect(start.getFullYear()).toBe(2026)
    expect(start.getMonth()).toBe(7)
    expect(start.getDate()).toBe(24)
    expect(start.getHours()).toBe(9)
    expect(start.getMinutes()).toBe(0)
    expect(end.getHours()).toBe(10)
    expect(end.getMinutes()).toBe(30)
  })
})

describe('identity across pushes', () => {
  it('derives the uid from the block, so the same block is recognised next time', () => {
    expect(toEvent(block())!.uid).toBe(uidFor('block-1'))
    expect(toEvent(block({ id: 'block-2' }))!.uid).not.toBe(uidFor('block-1'))
  })

  it('marks its own entries, and claims nothing else', () => {
    expect(isPlanUid(uidFor('block-1'))).toBe(true)
    // Anything you put in that calendar by hand must survive a reconcile.
    expect(isPlanUid('3F2504E0-4F89-11D3-9A0C-0305E82C3301')).toBe(false)
    expect(isPlanUid('some-meeting@icloud.com')).toBe(false)
  })
})

describe('deciding whether to rewrite', () => {
  it('leaves an unchanged block alone', () => {
    expect(sameAppointment(toEvent(block())!, toEvent(block())!)).toBe(true)
  })

  it('notices a move, a resize and a rename', () => {
    const original = toEvent(block())!
    expect(sameAppointment(original, toEvent(block({ startMin: 11 * 60 }))!)).toBe(false)
    expect(sameAppointment(original, toEvent(block({ endMin: 12 * 60 }))!)).toBe(false)
    expect(sameAppointment(original, toEvent(block({ taskTitle: 'Iets anders' }))!)).toBe(false)
  })

  it('ignores the explanation, which changes on every replan for the same work', () => {
    const a = toEvent(block({ explanation: 'Due soonest.' }))!
    const b = toEvent(block({ explanation: 'Highest score today.' }))!
    // Rewriting every entry because the reasoning was phrased differently would mean a full
    // calendar rewrite on every push.
    expect(sameAppointment(a, b)).toBe(true)
  })
})

describe('what actually goes over the wire', () => {
  it('survives being written and read back', () => {
    const event = toEvent(block())!
    const [back] = parseIcs(writeCalendar(event)).events

    expect(back!.uid).toBe(event.uid)
    expect(back!.summary).toBe('Hoofdstuk 6 afmaken')
    expect(back!.startsAt).toBe(event.startsAt)
    expect(back!.endsAt).toBe(event.endsAt)
  })

  it('survives a title holding characters the format reserves', () => {
    const event = toEvent(block({ taskTitle: 'Overleg: planning, fase 2; herzien' }))!
    const [back] = parseIcs(writeCalendar(event)).events
    expect(back!.summary).toBe('Overleg: planning, fase 2; herzien')
  })
})

describe('appointments that reach the phone', () => {
  const event = (overrides: Partial<CalendarEvent> = {}): CalendarEvent =>
    ({
      id: 'event-1',
      title: 'Tandarts',
      description: null,
      location: 'Zevenaar',
      startsAt: new Date('2026-10-01T15:00:00').getTime(),
      endsAt: new Date('2026-10-01T15:30:00').getTime(),
      allDay: false,
      cancelled: false,
      deletedAt: null,
      origin: 'uurwerk',
      ...overrides
    }) as CalendarEvent

  it('sends what Uurwerk or Jarvis made, with its own uid', () => {
    const wanted = appointmentEvents([event()])
    expect([...wanted.keys()]).toEqual([eventUid('event-1')])
    expect(isEventUid(eventUid('event-1'))).toBe(true)
    expect(isPlanUid(eventUid('event-1'))).toBe(false)
  })

  it('never sends back what came from iCloud or a subscription', () => {
    expect(appointmentEvents([event({ origin: 'icloud' }), event({ id: 'b', origin: 'ics' })]).size).toBe(0)
  })

  it('keeps an all-day item all-day, and drops cancelled or deleted ones', () => {
    const wanted = appointmentEvents([event({ id: 'day', allDay: true, title: 'Oma jarig' }), event({ id: 'gone', cancelled: true }), event({ id: 'del', deletedAt: 1 })])
    expect([...wanted.values()].map((entry) => [entry.summary, entry.allDay])).toEqual([['Oma jarig', true]])
  })

  it('writes an all-day item as a date, so the phone shows it above the day', () => {
    const [entry] = appointmentEvents([event({ allDay: true, startsAt: new Date('2026-10-01T00:00:00').getTime(), endsAt: new Date('2026-10-02T00:00:00').getTime() })]).values()
    const ics = writeCalendar(entry!)
    expect(ics).toContain('DTSTART;VALUE=DATE:20261001')
    expect(parseIcs(ics).events[0]!.allDay).toBe(true)
  })
})

describe('the calendar in the uid', () => {
  const event = (): CalendarEvent => ({ id: 'event-1', title: 'Tandarts', description: null, location: null, startsAt: 0, endsAt: 1, allDay: false, cancelled: false, deletedAt: null, origin: 'uurwerk' }) as CalendarEvent
  it('gives each target calendar its own uids, still recognised as ours', () => {
    const a = appointmentEvents([event()], 'https://p1/cal/a/')
    const b = appointmentEvents([event()], 'https://p1/cal/b/')
    const [uidA] = a.keys()
    const [uidB] = b.keys()
    expect(uidA).not.toBe(uidB)
    expect(isEventUid(uidA!)).toBe(true)
    expect(uidA).toMatch(/@uurwerk\.app$/)
  })
})
