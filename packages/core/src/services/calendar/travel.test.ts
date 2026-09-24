import { beforeEach, describe, expect, it } from 'vitest'
import { openStore, type Store } from '../../db/index.js'
import { SYSTEM_AREAS, SYSTEM_ORGANIZATIONS, type CalendarEvent } from '../../contract/types.js'
import {
  TRAVEL_WORK_TYPE_ID,
  registrableMinutes,
  travelAfterParentMoved,
  travelEventsFor
} from './travel.js'

const MINUTE = 60_000
const NINE = Date.parse('2026-08-18T09:00:00')
const TEN = Date.parse('2026-08-18T10:00:00')

let store: Store
let project: string

beforeEach(() => {
  store = openStore(':memory:')
  project = store.projects.create({
    name: 'GIS Applicatie EcoVi',
    organizationId: SYSTEM_ORGANIZATIONS.maasarend,
    areaId: SYSTEM_AREAS.stage
  }).id
})

function meeting(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  const event = store.calendar.createEvent({
    title: 'Projectoverleg Maasarend',
    startsAt: NINE,
    endsAt: TEN,
    origin: 'outlook',
    areaId: SYSTEM_AREAS.stage,
    organizationId: SYSTEM_ORGANIZATIONS.maasarend,
    projectId: project,
    workTypeId: 'work-type-meeting',
    classificationStatus: 'confirmed',
    registrationMode: 'calendar',
    countsAsWorked: true
  })
  return overrides ? { ...event, ...overrides } : event
}

describe('the blocks it makes', () => {
  it('sits either side of the appointment with no gap and no overlap', () => {
    const parent = meeting()
    const [outbound, back] = travelEventsFor(parent, {
      outboundMin: 30,
      returnMin: 45,
      countsAsWorked: true
    })

    expect(outbound!.startsAt).toBe(NINE - 30 * MINUTE)
    expect(outbound!.endsAt).toBe(NINE)
    expect(back!.startsAt).toBe(TEN)
    expect(back!.endsAt).toBe(TEN + 45 * MINUTE)
  })

  it('allows the journeys to differ, because they do', () => {
    const blocks = travelEventsFor(meeting(), {
      outboundMin: 30,
      returnMin: 45,
      countsAsWorked: false
    })

    expect(blocks[0]!.endsAt - blocks[0]!.startsAt).toBe(30 * MINUTE)
    expect(blocks[1]!.endsAt - blocks[1]!.startsAt).toBe(45 * MINUTE)
  })

  it('inherits area, organization and project, but is its own kind of work', () => {
    const [outbound] = travelEventsFor(meeting(), {
      outboundMin: 30,
      returnMin: 0,
      countsAsWorked: true
    })

    expect(outbound!.areaId).toBe(SYSTEM_AREAS.stage)
    expect(outbound!.organizationId).toBe(SYSTEM_ORGANIZATIONS.maasarend)
    expect(outbound!.projectId).toBe(project)
    expect(outbound!.workTypeId).toBe(TRAVEL_WORK_TYPE_ID)
    expect(outbound!.kind).toBe('travel')
  })

  it('makes only the journeys that exist', () => {
    expect(
      travelEventsFor(meeting(), { outboundMin: 0, returnMin: 0, countsAsWorked: false })
    ).toEqual([])

    const oneWay = travelEventsFor(meeting(), {
      outboundMin: 20,
      returnMin: 0,
      countsAsWorked: false
    })
    expect(oneWay).toHaveLength(1)
    expect(oneWay[0]!.travelDirection).toBe('outbound')
  })

  it('blocks the calendar even when the journey is not paid', () => {
    const [outbound] = travelEventsFor(meeting(), {
      outboundMin: 30,
      returnMin: 0,
      countsAsWorked: false
    })

    expect(outbound!.includeInPlanning).toBe(true)
    expect(outbound!.countsAsWorked).toBe(false)
    expect(outbound!.registrationMode).toBe('none')
  })
})

describe('when the meeting moves', () => {
  it('takes its travel with it, keeping the journey times', () => {
    const parent = meeting()
    const stored = travelEventsFor(parent, {
      outboundMin: 30,
      returnMin: 45,
      countsAsWorked: true
    }).map((input) => store.calendar.createEvent(input))

    // Pushed back by two hours.
    const moved: CalendarEvent = {
      ...parent,
      startsAt: NINE + 120 * MINUTE,
      endsAt: TEN + 120 * MINUTE
    }
    const shifts = travelAfterParentMoved(moved, stored)

    const outbound = shifts.find((shift) => shift.eventId === stored[0]!.id)!
    const back = shifts.find((shift) => shift.eventId === stored[1]!.id)!

    expect(outbound.endsAt).toBe(moved.startsAt)
    expect(outbound.endsAt - outbound.startsAt).toBe(30 * MINUTE)
    expect(back.startsAt).toBe(moved.endsAt)
    expect(back.endsAt - back.startsAt).toBe(45 * MINUTE)
  })

  it('leaves a block you edited yourself exactly where you put it', () => {
    const parent = meeting()
    const stored = travelEventsFor(parent, {
      outboundMin: 30,
      returnMin: 0,
      countsAsWorked: true
    }).map((input) => store.calendar.createEvent(input))

    // You know this journey takes an hour today, and said so.
    const detached = store.calendar.updateEvent(stored[0]!.id, {
      travelDetached: true,
      startsAt: NINE - 60 * MINUTE
    })

    const moved: CalendarEvent = { ...parent, startsAt: NINE + 60 * MINUTE, endsAt: TEN + 60 * MINUTE }
    expect(travelAfterParentMoved(moved, [detached])).toEqual([])
  })
})

describe('hours to register', () => {
  it('adds travel that counts as worked to the appointment', () => {
    const parent = meeting()
    const travel = travelEventsFor(parent, {
      outboundMin: 30,
      returnMin: 30,
      countsAsWorked: true
    }).map((input) => store.calendar.createEvent(input))

    // One hour of meeting, plus an hour of travelling.
    expect(registrableMinutes(parent, travel)).toBe(120)
  })

  it('leaves unpaid travel out of the total', () => {
    const parent = meeting()
    const travel = travelEventsFor(parent, {
      outboundMin: 30,
      returnMin: 30,
      countsAsWorked: false
    }).map((input) => store.calendar.createEvent(input))

    expect(registrableMinutes(parent, travel)).toBe(60)
  })

  it('registers nothing for an event that is not worked time', () => {
    const parent = meeting({ registrationMode: 'none' })
    expect(registrableMinutes(parent, [])).toBe(0)
  })

  it('prefers a confirmed duration over the scheduled one', () => {
    // The meeting was booked for an hour and took forty minutes.
    const parent = meeting({ confirmedMin: 40 })
    expect(registrableMinutes(parent, [])).toBe(40)
  })
})
