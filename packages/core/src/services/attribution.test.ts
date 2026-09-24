import { beforeEach, describe, expect, it } from 'vitest'
import { openStore, type Store } from '../db/index.js'
import { AttributionService } from './attribution.js'
import { BreakdownService } from './breakdown.js'
import { TrackingService } from './tracking.js'
import { SYSTEM_AREAS } from '../contract/types.js'
import { MINUTE_MS, dayRange, toIsoDate } from '../util/time.js'

let store: Store
let tracking: TrackingService
let attribution: AttributionService

beforeEach(() => {
  store = openStore(':memory:')
  tracking = new TrackingService(store)
  attribution = new AttributionService(store, tracking)
})

const stageTask = (title: string): string =>
  store.tasks.create({ title, areaId: SYSTEM_AREAS.stage }).id

const personalTask = (title: string): string =>
  store.tasks.create({ title, areaId: SYSTEM_AREAS.personal }).id

/** Yesterday, so nothing here depends on how far into today the suite runs. */
const DAY = toIsoDate(Date.now() - 24 * 60 * MINUTE_MS)
const dayStart = dayRange(DAY).startMs

/** A closed, task-less stretch — what pressing START and STOP without picking leaves. */
function stretch(fromMin: number, minutes: number): void {
  const at = dayStart + fromMin * MINUTE_MS
  tracking.startRun(null, at)
  tracking.stopRun(at + minutes * MINUTE_MS)
}

const minutesFor = (taskId: string): number =>
  attribution
    .day(DAY)
    .tasks.filter((task) => task.taskId === taskId)
    .reduce((sum, task) => sum + task.minutes, 0)

describe('what is up for division', () => {
  it('reports a bare start-stop as unattributed, not as nothing', () => {
    stretch(9 * 60, 120)

    const day = attribution.day(DAY)
    expect(day.unattributedMin).toBe(120)
    expect(day.trackedMin).toBe(0)
    expect(day.tasks).toHaveLength(0)
  })

  it('leaves time whose task was chosen while tracking alone', () => {
    const a = stageTask('Chosen live')
    const at = dayStart + 9 * 60 * MINUTE_MS
    tracking.startRun(a, at)
    tracking.stopRun(at + 60 * MINUTE_MS)

    attribution.apply(DAY, [{ taskId: stageTask('Given later'), sharePct: 100 }])

    const day = attribution.day(DAY)
    expect(day.trackedMin).toBe(60)
    expect(day.estimatedMin).toBe(0)
    expect(minutesFor(a)).toBe(60)
  })

  it('never divides the stretch that is still running', () => {
    const at = dayStart + 9 * 60 * MINUTE_MS
    tracking.startRun(null, at)

    attribution.apply(DAY, [{ taskId: stageTask('A'), sharePct: 100 }])

    expect(tracking.isRunning()).toBe(true)
    expect(tracking.currentSegment()!.taskId).toBeNull()
  })
})

describe('the split', () => {
  it('divides a stretch by the shares given', () => {
    const a = stageTask('A')
    const b = stageTask('B')
    stretch(9 * 60, 240)

    attribution.apply(DAY, [
      { taskId: a, sharePct: 75 },
      { taskId: b, sharePct: 25 }
    ])

    expect(minutesFor(a)).toBe(180)
    expect(minutesFor(b)).toBe(60)
  })

  it('neither creates nor loses a minute, however awkward the shares', () => {
    const a = stageTask('A')
    const b = stageTask('B')
    const c = stageTask('C')
    stretch(9 * 60, 100)

    attribution.apply(DAY, [
      { taskId: a, sharePct: 33 },
      { taskId: b, sharePct: 33 },
      { taskId: c, sharePct: 34 }
    ])

    const day = attribution.day(DAY)
    const total = day.tasks.reduce((sum, task) => sum + task.minutes, 0)
    expect(total + day.unattributedMin).toBe(100)
  })

  it('leaves the slices adjacent, so the stretch keeps its shape', () => {
    stretch(9 * 60, 180)
    attribution.apply(DAY, [
      { taskId: stageTask('A'), sharePct: 50 },
      { taskId: stageTask('B'), sharePct: 50 }
    ])

    const { startMs, endMs } = dayRange(DAY)
    const slices = store.tracking.segmentsInRange(startMs, endMs)
    expect(slices).toHaveLength(2)
    expect(slices[0]!.endedAt).toBe(slices[1]!.startedAt)
    expect(slices[0]!.startedAt).toBe(dayStart + 9 * 60 * MINUTE_MS)
    expect(slices[1]!.endedAt).toBe(dayStart + 12 * 60 * MINUTE_MS)
  })

  it('divides every stretch of the day by the same shares', () => {
    const a = stageTask('A')
    const b = stageTask('B')
    stretch(9 * 60, 120)
    stretch(13 * 60, 60)

    attribution.apply(DAY, [
      { taskId: a, sharePct: 50 },
      { taskId: b, sharePct: 50 }
    ])

    expect(minutesFor(a)).toBe(90)
    expect(minutesFor(b)).toBe(90)
  })

  it('keeps what the shares do not claim as untasked time rather than rounding it away', () => {
    const a = stageTask('A')
    stretch(9 * 60, 120)

    attribution.apply(DAY, [{ taskId: a, sharePct: 60 }])

    const day = attribution.day(DAY)
    expect(minutesFor(a)).toBe(72)
    expect(day.unattributedMin).toBe(48)
    // The hours were still worked, whatever they went to.
    expect(minutesFor(a) + day.unattributedMin).toBe(120)
  })

  it('reads an over-100 total as a ratio instead of refusing it', () => {
    const a = stageTask('A')
    const b = stageTask('B')
    stretch(9 * 60, 120)

    attribution.apply(DAY, [
      { taskId: a, sharePct: 60 },
      { taskId: b, sharePct: 60 }
    ])

    expect(minutesFor(a)).toBe(60)
    expect(minutesFor(b)).toBe(60)
    expect(attribution.day(DAY).unattributedMin).toBe(0)
  })

  it('gives a stretch too short to divide legibly to the biggest share whole', () => {
    const a = stageTask('A')
    const b = stageTask('B')
    stretch(9 * 60, 1)

    attribution.apply(DAY, [
      { taskId: a, sharePct: 30 },
      { taskId: b, sharePct: 70 }
    ])

    expect(minutesFor(b)).toBe(1)
    expect(minutesFor(a)).toBe(0)
  })

  it('marks every slice as estimated, so nothing reads it as measured', () => {
    stretch(9 * 60, 120)
    attribution.apply(DAY, [{ taskId: stageTask('A'), sharePct: 100 }])

    const { startMs, endMs } = dayRange(DAY)
    for (const slice of store.tracking.segmentsInRange(startMs, endMs)) {
      expect(slice.attribution).toBe('estimated')
      expect(slice.attributionGroup).not.toBeNull()
    }
  })

  it('moves an attributed task out of open, the way working on it live would', () => {
    const a = stageTask('A')
    stretch(9 * 60, 120)

    attribution.apply(DAY, [{ taskId: a, sharePct: 100 }])
    expect(store.tasks.get(a)!.status).toBe('in_progress')
  })
})

describe('stage hours', () => {
  it('start attributing is the moment untasked time becomes stage hours', () => {
    const a = stageTask('Fieldwork')
    stretch(9 * 60, 120)

    const breakdown = new BreakdownService(store)
    expect(breakdown.day(DAY).stageMin).toBe(0)

    attribution.apply(DAY, [{ taskId: a, sharePct: 100 }])
    expect(breakdown.day(DAY).stageMin).toBe(120)
  })

  it('resolves the rule per slice, not once for the stretch', () => {
    const work = stageTask('Fieldwork')
    const own = personalTask('Own project')
    stretch(9 * 60, 120)

    attribution.apply(DAY, [
      { taskId: work, sharePct: 50 },
      { taskId: own, sharePct: 50 }
    ])

    const breakdown = new BreakdownService(store)
    expect(breakdown.day(DAY).totalMin).toBe(120)
    expect(breakdown.day(DAY).stageMin).toBe(60)
  })
})

describe('correcting', () => {
  it('applying again reads the shares against the whole stretch, not the leftovers', () => {
    const a = stageTask('A')
    const b = stageTask('B')
    stretch(9 * 60, 120)

    attribution.apply(DAY, [{ taskId: a, sharePct: 100 }])
    attribution.apply(DAY, [
      { taskId: a, sharePct: 50 },
      { taskId: b, sharePct: 50 }
    ])

    expect(minutesFor(a)).toBe(60)
    expect(minutesFor(b)).toBe(60)
    expect(attribution.day(DAY).unattributedMin).toBe(0)
  })

  it('applying the same shares twice changes nothing', () => {
    const shares = [
      { taskId: stageTask('A'), sharePct: 40 },
      { taskId: stageTask('B'), sharePct: 60 }
    ]
    stretch(9 * 60, 150)

    const once = attribution.apply(DAY, shares)
    const twice = attribution.apply(DAY, shares)

    expect(twice.tasks).toEqual(once.tasks)
    expect(twice.unattributedMin).toBe(once.unattributedMin)
  })

  it('reverting puts the stretch back as one untasked segment', () => {
    stretch(9 * 60, 120)
    attribution.apply(DAY, [
      { taskId: stageTask('A'), sharePct: 50 },
      { taskId: stageTask('B'), sharePct: 50 }
    ])

    const day = attribution.revert(DAY)
    expect(day.unattributedMin).toBe(120)
    expect(day.tasks).toHaveLength(0)

    const { startMs, endMs } = dayRange(DAY)
    const segments = store.tracking.segmentsInRange(startMs, endMs)
    expect(segments).toHaveLength(1)
    expect(segments[0]!.durationMin).toBe(120)
    expect(segments[0]!.attribution).toBe('tracked')
    expect(segments[0]!.attributionGroup).toBeNull()
  })

  it('sending no shares at all is how you clear a day', () => {
    stretch(9 * 60, 120)
    attribution.apply(DAY, [{ taskId: stageTask('A'), sharePct: 100 }])

    const day = attribution.apply(DAY, [])
    expect(day.unattributedMin).toBe(120)
    expect(day.tasks).toHaveLength(0)
  })

  it('hands back the shares it used, so reopening the sheet shows what you said', () => {
    const a = stageTask('A')
    const b = stageTask('B')
    stretch(9 * 60, 200)

    attribution.apply(DAY, [
      { taskId: a, sharePct: 30 },
      { taskId: b, sharePct: 70 }
    ])

    const shares = attribution.day(DAY).shares
    expect(shares).toEqual([
      { taskId: b, sharePct: 70 },
      { taskId: a, sharePct: 30 }
    ])
  })

  it('recovered shares still fall short when the day was left partly untasked', () => {
    const a = stageTask('A')
    stretch(9 * 60, 120)

    attribution.apply(DAY, [{ taskId: a, sharePct: 60 }])
    expect(attribution.day(DAY).shares).toEqual([{ taskId: a, sharePct: 60 }])
  })

  it('keeps a screenshot attached by giving the original row to the biggest share', () => {
    const small = stageTask('Small')
    const big = stageTask('Big')
    stretch(9 * 60, 120)

    const { startMs, endMs } = dayRange(DAY)
    const original = store.tracking.segmentsInRange(startMs, endMs)[0]!
    store.artifacts.add({
      day: DAY,
      kind: 'screenshot',
      path: 'shot.jpg',
      capturedAt: original.startedAt + 10 * MINUTE_MS,
      timeSegmentId: original.id
    })

    attribution.apply(DAY, [
      { taskId: small, sharePct: 20 },
      { taskId: big, sharePct: 80 }
    ])

    const shot = store.artifacts.listByDay(DAY, 'screenshot')[0]!
    expect(shot.timeSegmentId).toBe(original.id)
    expect(store.tracking.getSegment(original.id)!.taskId).toBe(big)
  })
})

describe('day boundaries', () => {
  it('does not touch a division made on another day', () => {
    const a = stageTask('A')
    const b = stageTask('B')
    const other = toIsoDate(dayRange(DAY).startMs - 12 * 60 * MINUTE_MS)
    const otherStart = dayRange(other).startMs + 9 * 60 * MINUTE_MS

    tracking.startRun(null, otherStart)
    tracking.stopRun(otherStart + 60 * MINUTE_MS)
    attribution.apply(other, [{ taskId: a, sharePct: 100 }])

    stretch(9 * 60, 60)
    attribution.apply(DAY, [{ taskId: b, sharePct: 100 }])

    expect(attribution.day(other).tasks.map((task) => task.taskId)).toEqual([a])
    expect(attribution.day(DAY).tasks.map((task) => task.taskId)).toEqual([b])
  })
})

describe('hours entered by hand', () => {
  it('records a forgotten morning and divides it', () => {
    const a = stageTask('Fieldwork')
    const b = stageTask('Notes')

    const created = attribution.addStretch({
      date: DAY,
      startMin: 9 * 60,
      endMin: 12 * 60,
      shares: [
        { taskId: a, sharePct: 75 },
        { taskId: b, sharePct: 25 }
      ]
    })

    expect(created.durationMin).toBe(180)
    expect(created.attribution).toBe('manual')
    expect(minutesFor(a)).toBe(135)
    expect(minutesFor(b)).toBe(45)
  })

  it('counts hand-entered internship hours, which is the whole point of entering them', () => {
    const a = stageTask('Fieldwork')
    attribution.addStretch({
      date: DAY,
      startMin: 9 * 60,
      endMin: 11 * 60,
      shares: [{ taskId: a, sharePct: 100 }]
    })

    expect(new BreakdownService(store).day(DAY).stageMin).toBe(120)
  })

  it('refuses hours that overlap time already recorded', () => {
    stretch(9 * 60, 120)

    expect(() =>
      attribution.addStretch({
        date: DAY,
        startMin: 10 * 60,
        endMin: 13 * 60,
        shares: [{ taskId: stageTask('A'), sharePct: 100 }]
      })
    ).toThrow(/overlap/i)
  })

  it('allows a stretch that starts exactly where another ended', () => {
    stretch(9 * 60, 120)

    const created = attribution.addStretch({
      date: DAY,
      startMin: 11 * 60,
      endMin: 12 * 60,
      shares: [{ taskId: stageTask('A'), sharePct: 100 }]
    })
    expect(created.durationMin).toBe(60)
  })

  it('refuses a span with no minutes in it', () => {
    expect(() =>
      attribution.addStretch({
        date: DAY,
        startMin: 9 * 60,
        endMin: 9 * 60,
        shares: [{ taskId: stageTask('A'), sharePct: 100 }]
      })
    ).toThrow(/at least a minute/i)
  })

  it('is left alone by the end-of-day division', () => {
    const byHand = stageTask('Forgotten morning')
    const tracked = stageTask('Tracked afternoon')

    attribution.addStretch({
      date: DAY,
      startMin: 9 * 60,
      endMin: 11 * 60,
      shares: [{ taskId: byHand, sharePct: 100 }]
    })
    stretch(13 * 60, 120)

    // The day-wide step divides only what the clock measured and left untasked.
    const day = attribution.apply(DAY, [{ taskId: tracked, sharePct: 100 }])

    expect(minutesFor(byHand)).toBe(120)
    expect(minutesFor(tracked)).toBe(120)
    expect(day.unattributedMin).toBe(0)
  })

  it('survives a day-wide revert, which was never the day-wide step to undo it', () => {
    const byHand = stageTask('Forgotten morning')
    attribution.addStretch({
      date: DAY,
      startMin: 9 * 60,
      endMin: 11 * 60,
      shares: [{ taskId: byHand, sharePct: 100 }]
    })

    attribution.revert(DAY)
    expect(minutesFor(byHand)).toBe(120)
  })

  it('keeps its own kind when it has no shares at all', () => {
    const created = attribution.addStretch({
      date: DAY,
      startMin: 9 * 60,
      endMin: 11 * 60,
      shares: []
    })

    expect(created.attribution).toBe('manual')
    // Untasked, but not up for grabs: the day-wide step must not claim it.
    const day = attribution.apply(DAY, [{ taskId: stageTask('A'), sharePct: 100 }])
    expect(day.unattributedMin).toBe(120)
    expect(day.tasks).toHaveLength(0)
  })

  it('reads back as one stretch, whatever it was cut into', () => {
    const a = stageTask('A')
    const b = stageTask('B')
    const created = attribution.addStretch({
      date: DAY,
      startMin: 14 * 60,
      endMin: 17 * 60,
      shares: [
        { taskId: a, sharePct: 60 },
        { taskId: b, sharePct: 40 }
      ]
    })

    const read = attribution.stretch(created.id)!
    expect(read.startMin).toBe(14 * 60)
    expect(read.endMin).toBe(17 * 60)
    expect(read.durationMin).toBe(180)
    expect(read.shares).toEqual([
      { taskId: a, sharePct: 60 },
      { taskId: b, sharePct: 40 }
    ])
  })

  it('an evening running past midnight is a real shape, not an error', () => {
    const a = stageTask('Late')
    const created = attribution.addStretch({
      date: DAY,
      startMin: 23 * 60,
      endMin: 30,
      shares: [{ taskId: a, sharePct: 100 }]
    })

    expect(created.durationMin).toBe(90)
  })
})

describe('editing one stretch', () => {
  it('re-divides without disturbing the rest of the day', () => {
    const a = stageTask('A')
    const b = stageTask('B')
    const c = stageTask('C')

    const morning = attribution.addStretch({
      date: DAY,
      startMin: 9 * 60,
      endMin: 11 * 60,
      shares: [{ taskId: a, sharePct: 100 }]
    })
    attribution.addStretch({
      date: DAY,
      startMin: 13 * 60,
      endMin: 15 * 60,
      shares: [{ taskId: c, sharePct: 100 }]
    })

    attribution.updateStretch(morning.id, {
      date: DAY,
      startMin: 9 * 60,
      endMin: 11 * 60,
      shares: [
        { taskId: a, sharePct: 50 },
        { taskId: b, sharePct: 50 }
      ]
    })

    expect(minutesFor(a)).toBe(60)
    expect(minutesFor(b)).toBe(60)
    expect(minutesFor(c)).toBe(120)
  })

  it('resizing changes the hours the report will use', () => {
    const a = stageTask('A')
    const created = attribution.addStretch({
      date: DAY,
      startMin: 9 * 60,
      endMin: 11 * 60,
      shares: [{ taskId: a, sharePct: 100 }]
    })

    attribution.updateStretch(created.id, {
      date: DAY,
      startMin: 9 * 60,
      endMin: 13 * 60,
      shares: [{ taskId: a, sharePct: 100 }]
    })

    expect(minutesFor(a)).toBe(240)
    expect(new BreakdownService(store).day(DAY).totalMin).toBe(240)
  })

  it('resizing a measured stretch admits that its span is no longer measured', () => {
    stretch(9 * 60, 120)
    const a = stageTask('A')
    const day = attribution.apply(DAY, [{ taskId: a, sharePct: 100 }])
    expect(day.estimatedMin).toBe(120)

    const { startMs, endMs } = dayRange(DAY)
    const groupId = store.tracking.segmentsInRange(startMs, endMs)[0]!.attributionGroup!

    attribution.updateStretch(groupId, {
      date: DAY,
      startMin: 9 * 60,
      endMin: 12 * 60,
      shares: [{ taskId: a, sharePct: 100 }]
    })

    // Promoted to 'manual', which also takes it out of the day-wide step's reach.
    expect(attribution.stretch(groupId)!.attribution).toBe('manual')
    expect(minutesFor(a)).toBe(180)
  })

  it('re-dividing a measured stretch leaves its span measured', () => {
    stretch(9 * 60, 120)
    const a = stageTask('A')
    const b = stageTask('B')
    attribution.apply(DAY, [{ taskId: a, sharePct: 100 }])

    const { startMs, endMs } = dayRange(DAY)
    const groupId = store.tracking.segmentsInRange(startMs, endMs)[0]!.attributionGroup!

    attribution.updateStretch(groupId, {
      date: DAY,
      startMin: 9 * 60,
      endMin: 11 * 60,
      shares: [
        { taskId: a, sharePct: 50 },
        { taskId: b, sharePct: 50 }
      ]
    })

    expect(attribution.stretch(groupId)!.attribution).toBe('estimated')
  })

  it('refuses to move a stretch on top of another one', () => {
    const first = attribution.addStretch({
      date: DAY,
      startMin: 9 * 60,
      endMin: 11 * 60,
      shares: [{ taskId: stageTask('A'), sharePct: 100 }]
    })
    attribution.addStretch({
      date: DAY,
      startMin: 13 * 60,
      endMin: 15 * 60,
      shares: [{ taskId: stageTask('B'), sharePct: 100 }]
    })

    expect(() =>
      attribution.updateStretch(first.id, {
        date: DAY,
        startMin: 12 * 60,
        endMin: 14 * 60,
        shares: [{ taskId: stageTask('C'), sharePct: 100 }]
      })
    ).toThrow(/overlap/i)
  })

  it('does not count a stretch as overlapping itself', () => {
    const a = stageTask('A')
    const created = attribution.addStretch({
      date: DAY,
      startMin: 9 * 60,
      endMin: 11 * 60,
      shares: [{ taskId: a, sharePct: 100 }]
    })

    expect(() =>
      attribution.updateStretch(created.id, {
        date: DAY,
        startMin: 9 * 60 + 30,
        endMin: 11 * 60 + 30,
        shares: [{ taskId: a, sharePct: 100 }]
      })
    ).not.toThrow()
  })

  it('will not touch a stretch that is still running', () => {
    const at = dayStart + 9 * 60 * MINUTE_MS
    const open = tracking.startRun(null, at)

    expect(() =>
      attribution.updateStretch(open.id, {
        date: DAY,
        startMin: 9 * 60,
        endMin: 11 * 60,
        shares: [{ taskId: stageTask('A'), sharePct: 100 }]
      })
    ).toThrow(/still running/i)
  })

  it('divides a single tracked stretch from its own editor', () => {
    const a = stageTask('A')
    const b = stageTask('B')
    stretch(9 * 60, 120)

    const { startMs, endMs } = dayRange(DAY)
    const segment = store.tracking.segmentsInRange(startMs, endMs)[0]!

    attribution.updateStretch(segment.id, {
      date: DAY,
      startMin: 9 * 60,
      endMin: 11 * 60,
      shares: [
        { taskId: a, sharePct: 50 },
        { taskId: b, sharePct: 50 }
      ]
    })

    expect(minutesFor(a)).toBe(60)
    expect(minutesFor(b)).toBe(60)
  })

  it('deleting takes every slice and the run with it', () => {
    const created = attribution.addStretch({
      date: DAY,
      startMin: 9 * 60,
      endMin: 11 * 60,
      shares: [
        { taskId: stageTask('A'), sharePct: 50 },
        { taskId: stageTask('B'), sharePct: 50 }
      ]
    })

    attribution.removeStretch(created.id)

    const { startMs, endMs } = dayRange(DAY)
    expect(store.tracking.segmentsInRange(startMs, endMs)).toHaveLength(0)
    expect(store.tracking.runsInRange(startMs, endMs)).toHaveLength(0)
    expect(attribution.day(DAY).tasks).toHaveLength(0)
  })

  it('keeps the run over its segments after a move', () => {
    const created = attribution.addStretch({
      date: DAY,
      startMin: 9 * 60,
      endMin: 11 * 60,
      shares: [{ taskId: stageTask('A'), sharePct: 100 }]
    })

    attribution.updateStretch(created.id, {
      date: DAY,
      startMin: 14 * 60,
      endMin: 16 * 60,
      shares: [{ taskId: stageTask('A'), sharePct: 100 }]
    })

    const { startMs, endMs } = dayRange(DAY)
    const run = store.tracking.runsInRange(startMs, endMs)[0]!
    expect(run.startedAt).toBe(dayStart + 14 * 60 * MINUTE_MS)
    expect(run.endedAt).toBe(dayStart + 16 * 60 * MINUTE_MS)
  })
})

describe('correcting a single segment', () => {
  it('moving time to another task recomputes whether it counts as stage hours', () => {
    const own = personalTask('Own project')
    const work = stageTask('Fieldwork')

    const at = dayStart + 9 * 60 * MINUTE_MS
    const segment = tracking.startRun(own, at)
    tracking.stopRun(at + 60 * MINUTE_MS)

    const breakdown = new BreakdownService(store)
    expect(breakdown.day(DAY).stageMin).toBe(0)

    // Without re-resolving the rule here, an hour fixed by hand would stay out of the
    // internship total for good.
    tracking.editSegment(segment.id, { taskId: work })
    expect(breakdown.day(DAY).stageMin).toBe(60)
  })

  it('leaves the rule alone when the task did not change', () => {
    const work = stageTask('Fieldwork')
    const at = dayStart + 9 * 60 * MINUTE_MS
    const segment = tracking.startRun(work, at)
    tracking.stopRun(at + 60 * MINUTE_MS)

    tracking.editSegment(segment.id, { note: 'ran late' })
    expect(store.tracking.getSegment(segment.id)!.countsAsStageHours).toBe(true)
  })
})
