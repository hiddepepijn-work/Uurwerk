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
  it('warns 30 and 15 minutes before a planned task and as it starts, and not before a break', () => {
    const reminders = all([block(810, 900), block(900, 915, 'break')], [])
    expect(reminders.map((r) => [r.at, r.cue])).toEqual([
      [at(13), 'soon30'],
      [at(13, 15), 'soon15'],
      [at(13, 30), 'begins']
    ])
    expect(reminders.every((r) => r.title === 'Architectuur onderzoek')).toBe(true)
    expect(reminders[2]!.body).toBe('Nu · 13:30–15:00 · GIS Applicatie EcoVi')
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
    expect(reminders[1]!.title).toBe('Over een kwartier weg')
  })

  it('warns 30 and 15 minutes before an appointment without travel, and as it starts', () => {
    const reminders = all([], [event({ location: null })])
    expect(reminders.map((r) => [r.kind, r.at, r.title, r.cue])).toEqual([
      ['appointment', at(18, 30), 'Etentje met Tessie', 'soon30'],
      ['appointment', at(18, 45), 'Etentje met Tessie', 'soon15'],
      ['appointment', at(19), 'Etentje met Tessie', 'begins']
    ])
  })

  it('leaves out cancelled and all-day events, and anything outside the window', () => {
    expect(all([], [event({ cancelled: true }), event({ id: 'x', allDay: true })])).toEqual([])
    expect(upcomingReminders([block(600, 690)], [], at(11), at(24))).toEqual([])
  })
})

describe('check-ins on planned tasks', () => {
  const open = { priority: 'medium' as const, dueDate: null, status: 'open' as const }
  const all = (taskOf: Parameters<typeof upcomingReminders>[4]) => upcomingReminders([block(14 * 60, 16 * 60)], [], at(0), at(24), taskOf)

  it('asks halfway whether he started, and at the end whether it is done', () => {
    const checkins = all(() => open).filter((reminder) => reminder.kind === 'checkin')
    expect(checkins.map((reminder) => [reminder.checkin!.stage, reminder.at])).toEqual([
      ['midway', at(15)],
      ['end', at(16)]
    ])
    expect(checkins[0]!.title).toBe('Al bezig met Architectuur onderzoek?')
    expect(checkins[1]!.title).toBe('Architectuur onderzoek: gelukt?')
    expect(checkins.every((reminder) => reminder.checkin!.taskId === 't' && !reminder.checkin!.important)).toBe(true)
  })

  it('marks high priority, or a deadline within two days, as important', () => {
    expect(all(() => ({ ...open, priority: 'high' })).find((reminder) => reminder.kind === 'checkin')!.checkin!.important).toBe(true)
    expect(all(() => ({ ...open, dueDate: '2026-09-30' })).find((reminder) => reminder.kind === 'checkin')!.checkin!.important).toBe(true)
    expect(all(() => ({ ...open, dueDate: '2026-10-09' })).find((reminder) => reminder.kind === 'checkin')!.checkin!.important).toBe(false)
  })

  it('skips a task that is already done, a short block halfway, and blocks without a task lookup', () => {
    expect(all(() => ({ ...open, status: 'done' })).some((reminder) => reminder.kind === 'checkin')).toBe(false)
    const short = upcomingReminders([block(14 * 60, 14 * 60 + 20)], [], at(0), at(24), () => open).filter((reminder) => reminder.kind === 'checkin')
    expect(short.map((reminder) => reminder.checkin!.stage)).toEqual(['end'])
    expect(all(undefined).some((reminder) => reminder.kind === 'checkin')).toBe(false)
  })
})
