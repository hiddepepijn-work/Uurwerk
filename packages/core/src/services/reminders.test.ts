import { describe, expect, it } from 'vitest'

import type { CalendarEvent, PlanBlock } from '../contract/types.js'
import { fromIsoDate } from '../util/time.js'
import { upcomingReminders } from './reminders.js'

const DAY = '2026-09-28'
const at = (h: number, m = 0): number => fromIsoDate(DAY).getTime() + (h * 60 + m) * 60_000

const block = (startMin: number, endMin: number, kind: PlanBlock['kind'] = 'task'): PlanBlock =>
  ({
    id: `b${startMin}`,
    planId: 'p',
    taskId: 't',
    taskTitle: 'Architectuur onderzoek',
    areaId: 'stage',
    projectName: 'GIS Applicatie EcoVi',
    projectColor: null,
    date: DAY,
    startMin,
    endMin,
    kind,
    title: null,
    fixed: false,
    locked: false,
    source: 'planner',
    originalBlockId: null,
    explanation: null,
    score: null
  }) as PlanBlock

const event = (over: Partial<CalendarEvent>): CalendarEvent =>
  ({
    id: 'e1',
    title: 'Etentje met Tessie',
    location: 'Arnhem',
    startsAt: at(19),
    endsAt: at(21),
    allDay: false,
    kind: 'appointment',
    parentEventId: null,
    travelDirection: null,
    cancelled: false,
    ...over
  }) as CalendarEvent

const all = (blocks: PlanBlock[], events: CalendarEvent[]) =>
  upcomingReminders(blocks, events, at(0), at(24))

describe('reminders', () => {
  it('warns 15 minutes before a planned task, and not before a break', () => {
    const reminders = all([block(810, 900), block(900, 915, 'break')], [])
    expect(reminders).toHaveLength(1)
    expect(reminders[0]!.at).toBe(at(13, 15))
    expect(reminders[0]!.title).toBe('Over 15 min: Architectuur onderzoek')
  })

  it('counts back from leaving, not from the appointment, when there is travel', () => {
    const dinner = event({})
    const travel = event({
      id: 'e2',
      kind: 'travel',
      parentEventId: 'e1',
      travelDirection: 'outbound',
      startsAt: at(18, 25),
      endsAt: at(19)
    })
    const reminders = all([], [dinner, travel])
    expect(reminders.map((r) => [r.kind, r.at])).toEqual([
      ['gather', at(17, 55)],
      ['leave', at(18, 10)]
    ])
    expect(reminders[1]!.title).toBe('Hidde, lukt het?')
  })

  it('warns 15 minutes before an appointment without travel', () => {
    const [reminder] = all([], [event({ location: null })])
    expect(reminder!.kind).toBe('appointment')
    expect(reminder!.at).toBe(at(18, 45))
  })

  it('leaves out cancelled and all-day events, and anything outside the window', () => {
    expect(all([], [event({ cancelled: true }), event({ id: 'x', allDay: true })])).toEqual([])
    expect(upcomingReminders([block(600, 690)], [], at(11), at(24))).toEqual([])
  })
})
