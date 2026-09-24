/**
 * Area and organization are independent.
 *
 * Every case here exists because the opposite is the tempting shortcut: one employer, so
 * surely everything for them is the internship. It is not. Maasarend hosts the internship
 * *and* work that is not, and no total, filter or report may collapse the two.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { openStore, type Store } from '../db/index.js'
import { SYSTEM_AREAS, SYSTEM_ORGANIZATIONS } from '../contract/types.js'
import { MINUTE_MS, toIsoWeek } from '../util/time.js'
import { BreakdownService, seriesKey } from './breakdown.js'
import { StatsService } from './stats.js'
import { TrackingService } from './tracking.js'

const SCHOOL = 'school'
const RESEARCH = 'work-type-research'

let store: Store
let breakdown: BreakdownService
let stats: StatsService
let tracking: TrackingService

beforeEach(() => {
  store = openStore(':memory:')
  breakdown = new BreakdownService(store)
  stats = new StatsService(store)
  tracking = new TrackingService(store)
})

/** A project belonging to an organization, carrying no opinion about the area. */
function project(name: string, organizationId: string, shareable = false): string {
  return store.projects.create({ name, organizationId, shareable }).id
}

function task(
  title: string,
  areaId: string,
  projectId: string | null,
  workTypeId?: string
): string {
  return store.tasks.create({ title, areaId, projectId, workTypeId: workTypeId ?? null }).id
}

/** Tracks a closed stretch of work and returns the minutes it recorded. */
function track(taskId: string, minutes: number, endingMinutesAgo = 0): void {
  const endedAt = Date.now() - endingMinutesAgo * MINUTE_MS
  const startedAt = endedAt - minutes * MINUTE_MS
  tracking.startRun(taskId, startedAt)
  tracking.stopRun(endedAt)
}

const thisWeek = (): string => toIsoWeek(Date.now())

describe('one organization, two areas', () => {
  it('lets Maasarend be used by both Stage and Work', () => {
    const maasarend = project('SDSS', SYSTEM_ORGANIZATIONS.maasarend)
    const stage = task('Internship analysis', SYSTEM_AREAS.stage, maasarend)
    const work = task('Paid extra work', SYSTEM_AREAS.work, maasarend)

    expect(store.tasks.get(stage)!.organizationId).toBe(SYSTEM_ORGANIZATIONS.maasarend)
    expect(store.tasks.get(work)!.organizationId).toBe(SYSTEM_ORGANIZATIONS.maasarend)
    expect(store.tasks.get(stage)!.areaId).toBe(SYSTEM_AREAS.stage)
    expect(store.tasks.get(work)!.areaId).toBe(SYSTEM_AREAS.work)
  })

  it('counts Stage at Maasarend toward internship hours and Work at Maasarend not', () => {
    const maasarend = project('SDSS', SYSTEM_ORGANIZATIONS.maasarend)
    track(task('Internship analysis', SYSTEM_AREAS.stage, maasarend), 60)
    track(task('Paid extra work', SYSTEM_AREAS.work, maasarend), 30)

    const week = breakdown.week(thisWeek())

    expect(week.totalMin).toBe(90)
    expect(week.stageMin).toBe(60)
    expect(week.byArea[SYSTEM_AREAS.stage]).toBe(60)
    expect(week.byArea[SYSTEM_AREAS.work]).toBe(30)
    // One organization, both kinds of work — the total for Maasarend is the sum.
    expect(week.byOrganization[SYSTEM_ORGANIZATIONS.maasarend]).toBe(90)
  })

  it('shows Maasarend Stage and Maasarend Work as separate series', () => {
    const maasarend = project('SDSS', SYSTEM_ORGANIZATIONS.maasarend)
    track(task('Internship analysis', SYSTEM_AREAS.stage, maasarend), 60)
    track(task('Paid extra work', SYSTEM_AREAS.work, maasarend), 30)

    const series = breakdown.week(thisWeek()).byAreaAndOrganization

    expect(series[seriesKey(SYSTEM_AREAS.stage, SYSTEM_ORGANIZATIONS.maasarend)]).toBe(60)
    expect(series[seriesKey(SYSTEM_AREAS.work, SYSTEM_ORGANIZATIONS.maasarend)]).toBe(30)
  })

  it('does not rewrite recorded time when a Maasarend task moves from Stage to Work', () => {
    const maasarend = project('SDSS', SYSTEM_ORGANIZATIONS.maasarend)
    const id = task('Was internship work', SYSTEM_AREAS.stage, maasarend)
    track(id, 60)

    store.tasks.update(id, { areaId: SYSTEM_AREAS.work })

    // The hour was internship time when it happened, and it stays internship time.
    const week = breakdown.week(thisWeek())
    expect(week.stageMin).toBe(60)
    expect(week.byArea[SYSTEM_AREAS.stage]).toBe(60)
    expect(week.byArea[SYSTEM_AREAS.work]).toBeUndefined()
    // Only what comes next is classified the new way.
    expect(stats.totals(Date.now() - 2 * 60 * MINUTE_MS, Date.now()).stageMin).toBe(60)
  })

  it('does not change what counts as stage hours when only the organization changes', () => {
    const maasarend = project('SDSS', SYSTEM_ORGANIZATIONS.maasarend)
    const id = task('Internship analysis', SYSTEM_AREAS.stage, maasarend)
    track(id, 45)

    // Same work, re-filed under the school as if it had been for them all along.
    store.projects.update(maasarend, { organizationId: SYSTEM_ORGANIZATIONS.hasGreenAcademy })

    const week = breakdown.week(thisWeek())
    expect(week.stageMin).toBe(45)
    expect(week.byArea[SYSTEM_AREAS.stage]).toBe(45)
    expect(week.byOrganization[SYSTEM_ORGANIZATIONS.hasGreenAcademy]).toBe(45)
  })
})

describe('school', () => {
  it('tracks HAS Green Academy coursework separately and never as stage hours', () => {
    const maasarend = project('SDSS', SYSTEM_ORGANIZATIONS.maasarend)
    const school = project('Applied Geo-Information Science', SYSTEM_ORGANIZATIONS.hasGreenAcademy)

    track(task('Internship analysis', SYSTEM_AREAS.stage, maasarend), 60)
    track(task('Examination preparation', SCHOOL, school), 90)

    const week = breakdown.week(thisWeek())

    expect(week.stageMin).toBe(60)
    expect(week.byArea[SCHOOL]).toBe(90)
    expect(week.byOrganization[SYSTEM_ORGANIZATIONS.hasGreenAcademy]).toBe(90)
  })

  it('is shared with the teacher and not with the internship supervisor', () => {
    const school = store.areas.get(SCHOOL)!
    expect(school.countsAsStageHours).toBe(false)
    expect(school.defaultShareSupervisor).toBe(false)
    expect(school.defaultShareTeacher).toBe(true)
  })
})

describe('filters', () => {
  beforeEach(() => {
    const maasarend = project('SDSS', SYSTEM_ORGANIZATIONS.maasarend)
    const school = project('Applied Geo-Information Science', SYSTEM_ORGANIZATIONS.hasGreenAcademy)

    track(task('Internship analysis', SYSTEM_AREAS.stage, maasarend, RESEARCH), 60)
    track(task('Paid extra work', SYSTEM_AREAS.work, maasarend, RESEARCH), 30)
    track(task('Examination preparation', SCHOOL, school, RESEARCH), 90)
    track(task('Errand', SYSTEM_AREAS.personal, null), 15)
  })

  it('combines area and organization independently', () => {
    const week = thisWeek()

    // Internship for Maasarend only.
    expect(
      breakdown.week(week, {
        areaIds: [SYSTEM_AREAS.stage],
        organizationIds: [SYSTEM_ORGANIZATIONS.maasarend]
      }).totalMin
    ).toBe(60)

    // Non-internship work for the same organization.
    expect(
      breakdown.week(week, {
        areaIds: [SYSTEM_AREAS.work],
        organizationIds: [SYSTEM_ORGANIZATIONS.maasarend]
      }).totalMin
    ).toBe(30)

    // Everything for that organization, both kinds side by side.
    expect(
      breakdown.week(week, { organizationIds: [SYSTEM_ORGANIZATIONS.maasarend] }).totalMin
    ).toBe(90)

    // The school, which happens to be all School work — but by filter, not by assumption.
    expect(
      breakdown.week(week, { organizationIds: [SYSTEM_ORGANIZATIONS.hasGreenAcademy] }).totalMin
    ).toBe(90)
  })

  it('treats an empty filter as no filter, never as "match nothing"', () => {
    expect(breakdown.week(thisWeek(), { areaIds: [], organizationIds: [] }).totalMin).toBe(195)
  })

  it('keeps a separate series for every area, including Personal', () => {
    const week = breakdown.week(thisWeek())

    expect(week.byArea[SYSTEM_AREAS.stage]).toBe(60)
    expect(week.byArea[SYSTEM_AREAS.work]).toBe(30)
    expect(week.byArea[SCHOOL]).toBe(90)
    expect(week.byArea[SYSTEM_AREAS.personal]).toBe(15)
    expect(week.stageMin).toBe(60)
  })
})

describe('work types', () => {
  it('uses one Research record across Stage, Work and School', () => {
    const maasarend = project('SDSS', SYSTEM_ORGANIZATIONS.maasarend)
    const school = project('Applied Geo-Information Science', SYSTEM_ORGANIZATIONS.hasGreenAcademy)

    track(task('Internship research', SYSTEM_AREAS.stage, maasarend, RESEARCH), 60)
    track(task('Paid research', SYSTEM_AREAS.work, maasarend, RESEARCH), 30)
    track(task('Course research', SCHOOL, school, RESEARCH), 90)

    const week = breakdown.week(thisWeek())

    // One work type, 180 minutes, spread across three areas — not three near-identical rows.
    expect(week.byWorkType[RESEARCH]).toBe(180)
    expect(store.workTypes.list().filter((type) => type.slug === 'research')).toHaveLength(1)

    expect(breakdown.week(thisWeek(), { workTypeIds: [RESEARCH] }).byArea).toEqual({
      [SYSTEM_AREAS.stage]: 60,
      [SYSTEM_AREAS.work]: 30,
      [SCHOOL]: 90
    })
  })
})

describe('no area is ever derived from an organization', () => {
  it('keeps the area the task was given, whatever its organization', () => {
    const maasarend = project('SDSS', SYSTEM_ORGANIZATIONS.maasarend)

    // The tempting inference is "Maasarend, therefore Stage". The task says Work.
    const id = task('Paid extra work', SYSTEM_AREAS.work, maasarend)
    const stored = store.tasks.get(id)!

    expect(stored.areaId).toBe(SYSTEM_AREAS.work)
    expect(stored.organizationId).toBe(SYSTEM_ORGANIZATIONS.maasarend)

    track(id, 30)
    expect(breakdown.week(thisWeek()).stageMin).toBe(0)
  })

  it('gives a project no say over an area the task states itself', () => {
    // A project may carry a default area; an explicit task area always wins over it.
    const id = store.projects.create({
      name: 'Internship project',
      organizationId: SYSTEM_ORGANIZATIONS.maasarend,
      areaId: SYSTEM_AREAS.stage
    }).id

    const work = task('Paid extra work', SYSTEM_AREAS.work, id)
    expect(store.tasks.get(work)!.areaId).toBe(SYSTEM_AREAS.work)
  })
})
