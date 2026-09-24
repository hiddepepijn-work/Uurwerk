import { beforeEach, describe, expect, it } from 'vitest'
import { openStore, type Store } from '../../db/index.js'
import { SYSTEM_AREAS, SYSTEM_ORGANIZATIONS, type TrackedTotals } from '../../contract/types.js'
import { StatsService } from '../stats.js'
import { CalendarService, type ClassificationChoice } from './index.js'
import { registrableWindow } from './reconcile.js'

const MINUTE = 60_000
const NINE = Date.parse('2026-08-18T09:00:00')
const TEN = Date.parse('2026-08-18T10:00:00')
/** The ISO week containing 18 August 2026, a Tuesday. */
const WEEK = '2026-W34'

let store: Store
let calendar: CalendarService
let stats: StatsService
let project: string

beforeEach(() => {
  store = openStore(':memory:')
  calendar = new CalendarService(store)
  stats = new StatsService(store)
  project = store.projects.create({
    name: 'GIS Applicatie EcoVi',
    organizationId: SYSTEM_ORGANIZATIONS.maasarend,
    areaId: SYSTEM_AREAS.stage
  }).id
})

/** An imported appointment, exactly as a sync leaves it: classified by nobody, counting nothing. */
function imported(startsAt = NINE, endsAt = TEN): string {
  return store.calendar.createEvent({
    title: 'Projectoverleg Maasarend',
    startsAt,
    endsAt,
    origin: 'outlook',
    classificationStatus: 'suggested'
  }).id
}

function choice(overrides: Partial<ClassificationChoice> = {}): ClassificationChoice {
  return {
    areaId: SYSTEM_AREAS.stage,
    organizationId: SYSTEM_ORGANIZATIONS.maasarend,
    projectId: project,
    workTypeId: 'work-type-meeting',
    remember: false,
    includeInPlanning: true,
    registrationMode: 'calendar',
    countsAsWorked: true,
    ...overrides
  }
}

/** Everything tracked around the appointment, split the way the stat cards split it. */
const trackedMin = (): TrackedTotals =>
  stats.totals(NINE - 12 * 60 * MINUTE, TEN + 12 * 60 * MINUTE)

describe('which events register hours at all', () => {
  it('registers nothing while the mode is none, whatever else is set', () => {
    const event = store.calendar.event(imported())!
    expect(registrableWindow({ ...event, registrationMode: 'none', countsAsWorked: true })).toBeNull()
  })

  it('registers nothing for an event that does not count as worked', () => {
    const event = store.calendar.event(imported())!
    expect(
      registrableWindow({ ...event, registrationMode: 'calendar', countsAsWorked: false })
    ).toBeNull()
  })

  it('registers nothing for a cancelled or deleted event', () => {
    const event = { ...store.calendar.event(imported())!, registrationMode: 'calendar' as const, countsAsWorked: true }
    expect(registrableWindow({ ...event, cancelled: true })).toBeNull()
    expect(registrableWindow({ ...event, deletedAt: Date.now() })).toBeNull()
  })

  it('prefers the confirmed length over the length in the calendar', () => {
    const event = {
      ...store.calendar.event(imported())!,
      registrationMode: 'confirm' as const,
      countsAsWorked: true,
      confirmedMin: 20
    }
    expect(registrableWindow(event)).toEqual({ startedAt: NINE, endedAt: NINE + 20 * MINUTE })
  })
})

describe('classifying an event as worked time', () => {
  it('turns it into hours the rest of the app can actually see', () => {
    const id = imported()
    expect(trackedMin().totalMin).toBe(0)

    calendar.applyClassification(id, choice())

    // The bug this covers: the classification used to be stored on the event and nowhere
    // else, so every reader of hours went on answering zero.
    const totals = trackedMin()
    expect(totals.totalMin).toBe(60)
    expect(totals.stageMin).toBe(60)
    expect(store.tracking.segmentsInRange(NINE, TEN)).toHaveLength(1)
  })

  it('points the event at the segment it produced', () => {
    const id = imported()
    calendar.applyClassification(id, choice())

    const segmentId = store.calendar.event(id)!.reconciledSegmentId
    expect(segmentId).not.toBeNull()
    expect(store.tracking.getSegment(segmentId!)).not.toBeNull()
  })

  it('counts an hour outside the internship as worked but not as stage hours', () => {
    const id = imported()
    calendar.applyClassification(id, choice({ areaId: SYSTEM_AREAS.personal, projectId: null }))

    const totals = trackedMin()
    expect(totals.totalMin).toBe(60)
    expect(totals.stageMin).toBe(0)
    expect(totals.otherMin).toBe(60)
  })

  it('leaves a live timer run alone', () => {
    const open = store.tracking.startRun(NINE)
    store.tracking.startSegment({
      trackingRunId: open.id,
      taskId: null,
      areaId: SYSTEM_AREAS.stage,
      countsAsStageHours: true,
      at: NINE
    })

    calendar.applyClassification(imported(), choice())

    // The derived run closes itself, so the one the user started is still the current one.
    expect(store.tracking.currentRun()?.id).toBe(open.id)
  })
})

describe('changing your mind', () => {
  it('withdraws the hours when the event stops counting', () => {
    const id = imported()
    calendar.applyClassification(id, choice())
    expect(trackedMin().totalMin).toBe(60)

    calendar.applyClassification(id, choice({ registrationMode: 'none', countsAsWorked: false }))

    expect(trackedMin().totalMin).toBe(0)
    expect(store.calendar.event(id)!.reconciledSegmentId).toBeNull()
  })

  it('does not register the same hour twice when reclassified', () => {
    const id = imported()
    calendar.applyClassification(id, choice())
    calendar.applyClassification(id, choice({ workTypeId: 'work-type-research' }))

    expect(trackedMin().totalMin).toBe(60)
    expect(store.tracking.segmentsInRange(NINE, TEN)).toHaveLength(1)
  })

  it('follows the area to the new one, stage hours and all', () => {
    const id = imported()
    calendar.applyClassification(id, choice())
    expect(trackedMin().stageMin).toBe(60)

    calendar.applyClassification(id, choice({ areaId: SYSTEM_AREAS.personal, projectId: null }))

    expect(trackedMin().stageMin).toBe(0)
    expect(trackedMin().otherMin).toBe(60)
  })

  it('leaves no run behind when the hours are withdrawn', () => {
    const id = imported()
    calendar.applyClassification(id, choice())
    const before = store.tracking.runsInRange(NINE - MINUTE, TEN + MINUTE).length

    calendar.applyClassification(id, choice({ registrationMode: 'none', countsAsWorked: false }))

    expect(store.tracking.runsInRange(NINE - MINUTE, TEN + MINUTE).length).toBe(before - 1)
  })
})

describe('unfiling', () => {
  it('takes the hours back, so nothing counts for an event filed under nothing', () => {
    const id = imported()
    calendar.applyClassification(id, choice())
    expect(trackedMin().totalMin).toBe(60)

    calendar.ignore(id)

    expect(trackedMin().totalMin).toBe(0)
    expect(store.calendar.event(id)!.reconciledSegmentId).toBeNull()
    expect(store.calendar.event(id)!.registrationMode).toBe('none')
  })

  it('takes the travel hours back with them', () => {
    const id = imported()
    calendar.applyClassification(
      id,
      choice({ travel: { outboundMin: 30, returnMin: 30, countsAsWorked: true } })
    )
    expect(trackedMin().totalMin).toBe(120)

    calendar.ignore(id)

    expect(trackedMin().totalMin).toBe(0)
  })
})

describe('travel', () => {
  it('registers the journey alongside the appointment when it counts', () => {
    const id = imported()
    calendar.applyClassification(
      id,
      choice({ travel: { outboundMin: 30, returnMin: 30, countsAsWorked: true } })
    )

    expect(trackedMin().totalMin).toBe(120)
  })

  it('registers only the appointment when the journey does not count', () => {
    const id = imported()
    calendar.applyClassification(
      id,
      choice({ travel: { outboundMin: 30, returnMin: 30, countsAsWorked: false } })
    )

    expect(trackedMin().totalMin).toBe(60)
  })

  it('takes the hours back when the journey is removed', () => {
    const id = imported()
    calendar.applyClassification(
      id,
      choice({ travel: { outboundMin: 30, returnMin: 30, countsAsWorked: true } })
    )
    expect(trackedMin().totalMin).toBe(120)

    calendar.applyClassification(id, choice())

    expect(trackedMin().totalMin).toBe(60)
  })
})

describe('when the appointment moves', () => {
  it('takes its hours with it', () => {
    const id = imported()
    calendar.applyClassification(id, choice())

    const nextDay = NINE + 24 * 60 * MINUTE
    calendar.moveEvent(id, nextDay, nextDay + 60 * MINUTE)

    expect(store.tracking.segmentsInRange(NINE, TEN)).toHaveLength(0)
    expect(store.tracking.segmentsInRange(nextDay, nextDay + 60 * MINUTE)).toHaveLength(1)
  })

  it('registers the new length when the appointment is made longer', () => {
    const id = imported()
    calendar.applyClassification(id, choice())

    calendar.moveEvent(id, NINE, TEN + 30 * MINUTE)

    expect(trackedMin().totalMin).toBe(90)
  })
})

describe('what the week sees', () => {
  it('counts registered calendar hours toward the week total', () => {
    calendar.applyClassification(imported(), choice())
    expect(stats.week(WEEK).trackedMin).toBe(60)
  })
})
