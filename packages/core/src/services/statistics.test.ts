import { beforeEach, describe, expect, it } from 'vitest'
import { openStore, type Store } from '../db/index.js'
import { SYSTEM_AREAS, SYSTEM_ORGANIZATIONS } from '../contract/types.js'
import { MINUTE_MS, addDays, atMinuteOfDay, startOfIsoWeek, toIsoDate } from '../util/time.js'
import { StatisticsService, resolveRange } from './statistics.js'

let store: Store
let statistics: StatisticsService
let monday: string

beforeEach(() => {
  store = openStore(':memory:')
  statistics = new StatisticsService(store)
  monday = toIsoDate(startOfIsoWeek(Date.now()))
})

function project(name: string, organizationId: string): string {
  return store.projects.create({ name, organizationId }).id
}

function task(title: string, areaId: string, projectId: string | null, workTypeId?: string): string {
  return store.tasks.create({ title, areaId, projectId, workTypeId: workTypeId ?? null }).id
}

/** Tracks a stretch on a given day, in minutes past midnight. */
function track(taskId: string, date: string, fromMin: number, toMin: number): void {
  const run = store.tracking.startRun(atMinuteOfDay(date, fromMin))
  const segment = store.tracking.startSegment({
    trackingRunId: run.id,
    taskId,
    areaId: store.tasks.get(taskId)!.areaId,
    countsAsStageHours:
      store.areas.get(store.tasks.get(taskId)!.areaId ?? '')?.countsAsStageHours ?? false,
    at: atMinuteOfDay(date, fromMin)
  })
  store.tracking.endSegment(segment.id, atMinuteOfDay(date, toMin), 'stopped')
  store.tracking.endRun(run.id, atMinuteOfDay(date, toMin))
}

function planBlock(taskId: string, date: string, fromMin: number, toMin: number): void {
  const existing = store.plans.accepted('day', date)
  if (existing) {
    store.plans.addBlock(existing.id, { taskId, date, startMin: fromMin, endMin: toMin })
    return
  }
  const draft = store.plans.createDraft({ scope: 'day', periodKey: date })
  store.plans.addBlock(draft.id, { taskId, date, startMin: fromMin, endMin: toMin })
  store.plans.accept(draft.id)
}

describe('ranges', () => {
  it('shows a week as seven days and four weeks as four columns', () => {
    expect(resolveRange({ preset: 'week' }).buckets).toHaveLength(7)
    expect(resolveRange({ preset: 'week' }).daily).toBe(true)

    const fourWeeks = resolveRange({ preset: '4weeks' })
    expect(fourWeeks.buckets).toHaveLength(4)
    expect(fourWeeks.daily).toBe(false)
    expect(fourWeeks.days).toHaveLength(28)
  })

  it('groups a long custom range by week rather than drawing a barcode', () => {
    const from = toIsoDate(addDays(Date.now(), -40))
    const to = toIsoDate(Date.now())
    const range = resolveRange({ preset: 'custom', from, to })

    expect(range.daily).toBe(false)
    expect(range.buckets.length).toBeLessThan(10)
  })
})

describe('the headline figures', () => {
  it('separates tracked time from stage hours', () => {
    const maasarend = project('SDSS', SYSTEM_ORGANIZATIONS.maasarend)
    track(task('Internship analysis', SYSTEM_AREAS.stage, maasarend), monday, 9 * 60, 12 * 60)
    track(task('Paid extra work', SYSTEM_AREAS.work, maasarend), monday, 13 * 60, 14 * 60)

    const overview = statistics.overview({ preset: 'week' })

    expect(overview.tracked.min).toBe(240)
    expect(overview.stage.min).toBe(180)
  })

  it('reports plan completion against planned time, and nothing when there is no plan', () => {
    const maasarend = project('SDSS', SYSTEM_ORGANIZATIONS.maasarend)
    const id = task('Internship analysis', SYSTEM_AREAS.stage, maasarend)

    expect(statistics.overview({ preset: 'week' }).planCompletion).toBeNull()

    planBlock(id, monday, 9 * 60, 13 * 60)
    track(id, monday, 9 * 60, 12 * 60)

    const overview = statistics.overview({ preset: 'week' })
    expect(overview.planned.min).toBe(240)
    expect(overview.planCompletion).toBeCloseTo(0.75, 5)
  })

  it('compares against the period immediately before, not against zero', () => {
    const maasarend = project('SDSS', SYSTEM_ORGANIZATIONS.maasarend)
    const id = task('Internship analysis', SYSTEM_AREAS.stage, maasarend)

    const lastMonday = toIsoDate(addDays(startOfIsoWeek(Date.now()), -7))
    track(id, lastMonday, 9 * 60, 11 * 60)
    track(id, monday, 9 * 60, 12 * 60)

    const overview = statistics.overview({ preset: 'week' })
    expect(overview.tracked.min).toBe(180)
    expect(overview.tracked.previousMin).toBe(120)
  })
})

describe('the panels obey the filters', () => {
  beforeEach(() => {
    const maasarend = project('SDSS', SYSTEM_ORGANIZATIONS.maasarend)
    const school = project('Applied Geo-Information Science', SYSTEM_ORGANIZATIONS.hasGreenAcademy)

    track(task('Internship analysis', SYSTEM_AREAS.stage, maasarend, 'work-type-research'), monday, 9 * 60, 12 * 60)
    track(task('Paid extra work', SYSTEM_AREAS.work, maasarend, 'work-type-development'), monday, 13 * 60, 14 * 60)
    track(task('Examination preparation', 'school', school, 'work-type-coursework'), monday, 19 * 60, 21 * 60)
  })

  it('splits time by area with shares that add up', () => {
    const areas = statistics.overview({ preset: 'week' }).areas

    expect(areas.map((area) => area.areaId)).toEqual([SYSTEM_AREAS.stage, 'school', SYSTEM_AREAS.work])
    expect(areas.reduce((sum, area) => sum + area.fraction, 0)).toBeCloseTo(1, 5)
    // Colour comes from the area itself, so the chart and Settings can never disagree.
    expect(areas[0]!.color).toBe(store.areas.get(SYSTEM_AREAS.stage)!.color)
  })

  it('narrows every panel when an organization is chosen', () => {
    const overview = statistics.overview(
      { preset: 'week' },
      { organizationIds: [SYSTEM_ORGANIZATIONS.hasGreenAcademy] }
    )

    expect(overview.tracked.min).toBe(120)
    expect(overview.areas.map((area) => area.areaId)).toEqual(['school'])
    expect(overview.projects.map((entry) => entry.name)).toEqual([
      'Applied Geo-Information Science'
    ])
  })

  it('keeps area and organization independent', () => {
    // Maasarend hosts both; asking for Stage there excludes the paid work at the same employer.
    const overview = statistics.overview(
      { preset: 'week' },
      { areaIds: [SYSTEM_AREAS.stage], organizationIds: [SYSTEM_ORGANIZATIONS.maasarend] }
    )

    expect(overview.tracked.min).toBe(180)
    expect(overview.stage.min).toBe(180)
  })

  it('marks which projects count toward internship hours', () => {
    const projects = statistics.overview({ preset: 'week' }).projects
    const sdss = projects.find((entry) => entry.name === 'SDSS')!
    const school = projects.find((entry) => entry.name === 'Applied Geo-Information Science')!

    expect(sdss.countsAsStageHours).toBe(true)
    expect(school.countsAsStageHours).toBe(false)
  })
})

describe('planned against actual, per work type', () => {
  it('names work that was tracked but never planned', () => {
    const maasarend = project('SDSS', SYSTEM_ORGANIZATIONS.maasarend)
    const planned = task('Planned research', SYSTEM_AREAS.stage, maasarend, 'work-type-research')
    const surprise = task('Surprise fix', SYSTEM_AREAS.stage, maasarend, 'work-type-development')

    planBlock(planned, monday, 9 * 60, 12 * 60)
    track(planned, monday, 9 * 60, 11 * 60)
    track(surprise, monday, 13 * 60, 14 * 60)

    const rows = statistics.overview({ preset: 'week' }).workTypes
    const research = rows.find((row) => row.workTypeId === 'work-type-research')!
    const development = rows.find((row) => row.workTypeId === 'work-type-development')!

    expect(research.plannedMin).toBe(180)
    expect(research.actualMin).toBe(120)
    expect(development.plannedMin).toBe(0)
    expect(development.actualMin).toBe(60)
  })
})

describe('data quality', () => {
  it('counts what is missing rather than quietly averaging it in', () => {
    const maasarend = project('SDSS', SYSTEM_ORGANIZATIONS.maasarend)
    const id = task('Internship analysis', SYSTEM_AREAS.stage, maasarend)
    track(id, monday, 9 * 60, 10 * 60)

    const quality = statistics.overview({ preset: 'week' }).quality

    // One open task with no estimate, and time tracked without a work type.
    expect(quality.tasksWithoutEstimate).toBe(1)
    expect(quality.categorisedFraction).toBe(0)
    expect(quality.score).toBeLessThan(1)
  })

  it('is clean when everything is labelled', () => {
    const maasarend = project('SDSS', SYSTEM_ORGANIZATIONS.maasarend)
    const id = store.tasks.create({
      title: 'Internship analysis',
      areaId: SYSTEM_AREAS.stage,
      projectId: maasarend,
      workTypeId: 'work-type-research',
      estimateMin: 120
    }).id
    track(id, monday, 9 * 60, 10 * 60)

    expect(statistics.overview({ preset: 'week' }).quality.score).toBe(1)
  })
})

describe('screen time', () => {
  it('says it has never been measured rather than reporting zero', () => {
    expect(statistics.overview({ preset: 'week' }).hasScreenTime).toBe(false)
  })

  it('totals awake minutes per day once they are recorded', () => {
    store.screenTime.add(monday, 8 * 60)
    store.screenTime.add(monday, 30)
    store.screenTime.add(toIsoDate(addDays(startOfIsoWeek(Date.now()), 1)), 60)

    const overview = statistics.overview({ preset: 'week' })

    expect(overview.hasScreenTime).toBe(true)
    expect(overview.screenTime.min).toBe(9 * 60 + 30)
    expect(overview.buckets[0]!.screenTimeMin).toBe(8 * 60 + 30)
    expect(overview.buckets[1]!.screenTimeMin).toBe(60)
  })

  it('keeps screen time out of tracked time', () => {
    const maasarend = project('SDSS', SYSTEM_ORGANIZATIONS.maasarend)
    track(task('Internship analysis', SYSTEM_AREAS.stage, maasarend), monday, 9 * 60, 10 * 60)
    store.screenTime.add(monday, 8 * 60)

    const overview = statistics.overview({ preset: 'week' })
    expect(overview.tracked.min).toBe(60)
    expect(overview.screenTime.min).toBe(480)
  })
})

describe('insights', () => {
  it('reports the share of tracked time that was never planned', () => {
    const maasarend = project('SDSS', SYSTEM_ORGANIZATIONS.maasarend)
    const planned = task('Planned work', SYSTEM_AREAS.stage, maasarend)
    const unplanned = task('Unplanned work', SYSTEM_AREAS.stage, maasarend)

    planBlock(planned, monday, 9 * 60, 12 * 60)
    track(planned, monday, 9 * 60, 12 * 60)
    track(unplanned, monday, 13 * 60, 14 * 60)

    const insight = statistics
      .overview({ preset: 'week' })
      .insights.find((entry) => entry.kind === 'unplanned-share')

    // One unplanned hour out of four tracked.
    expect(insight?.text).toContain('25%')
  })

  it('says nothing about unplanned work when everything was planned', () => {
    const maasarend = project('SDSS', SYSTEM_ORGANIZATIONS.maasarend)
    const id = task('Planned work', SYSTEM_AREAS.stage, maasarend)
    planBlock(id, monday, 9 * 60, 12 * 60)
    track(id, monday, 9 * 60, 12 * 60)

    expect(
      statistics.overview({ preset: 'week' }).insights.some((i) => i.kind === 'unplanned-share')
    ).toBe(false)
  })
})

describe('a quiet period', () => {
  it('returns an empty but usable overview', () => {
    const overview = statistics.overview({ preset: '4weeks' })

    expect(overview.tracked.min).toBe(0)
    expect(overview.areas).toEqual([])
    expect(overview.projects).toEqual([])
    expect(overview.planCompletion).toBeNull()
    expect(overview.buckets).toHaveLength(4)
    expect(overview.buckets.every((bucket) => bucket.trackedMin === 0)).toBe(true)
  })
})

describe('minutes are minutes', () => {
  it('does not double count a segment that spans midnight', () => {
    const maasarend = project('SDSS', SYSTEM_ORGANIZATIONS.maasarend)
    const id = task('Late night', SYSTEM_AREAS.stage, maasarend)

    const start = atMinuteOfDay(monday, 23 * 60 + 30)
    const run = store.tracking.startRun(start)
    const segment = store.tracking.startSegment({
      trackingRunId: run.id,
      taskId: id,
      areaId: SYSTEM_AREAS.stage,
      countsAsStageHours: true,
      at: start
    })
    store.tracking.endSegment(segment.id, start + 60 * MINUTE_MS, 'stopped')

    const overview = statistics.overview({ preset: 'week' })
    const inBuckets = overview.buckets.reduce((sum, bucket) => sum + bucket.trackedMin, 0)

    expect(overview.tracked.min).toBe(60)
    expect(inBuckets).toBe(60)
  })
})
