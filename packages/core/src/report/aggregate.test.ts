import { beforeEach, describe, expect, it } from 'vitest'
import { openStore, type Store } from '../db/index.js'
import { PlanningService } from '../services/planning.js'
import { StatsService } from '../services/stats.js'
import { ReportAggregator } from './aggregate.js'
import { atMinuteOfDay, startOfIsoWeek, toIsoDate, toIsoWeek } from '../util/time.js'

let store: Store
let stats: StatsService
let planning: PlanningService
let reports: ReportAggregator
let week: string
let monday: string

beforeEach(() => {
  store = openStore(':memory:')
  stats = new StatsService(store)
  planning = new PlanningService(store, stats)
  reports = new ReportAggregator(store, stats, planning)

  week = toIsoWeek(Date.now())
  monday = toIsoDate(startOfIsoWeek(Date.now()))
})

/**
 * Plans a block on a given day by accepting a day plan.
 *
 * Planned time now comes from the versioned plan model, not the pre-planner `planned`
 * table, so the tests have to plan the way the app does.
 */
function planBlock(taskId: string, date: string, from: number, to: number): void {
  const existing = store.plans.accepted('day', date)
  if (existing) {
    store.plans.addBlock(existing.id, { taskId, date, startMin: from, endMin: to })
    return
  }
  const draft = store.plans.createDraft({ scope: 'day', periodKey: date })
  store.plans.addBlock(draft.id, { taskId, date, startMin: from, endMin: to })
  store.plans.accept(draft.id)
}

/** Logs a closed tracking segment on a given day, from minute-of-day `from` to `to`. */
function logSession(taskId: string, date: string, from: number, to: number): void {
  const run = store.tracking.startRun(atMinuteOfDay(date, from))
  const segment = store.tracking.startSegment({
    trackingRunId: run.id,
    taskId,
    areaId: 'stage',
    countsAsStageHours: true,
    at: atMinuteOfDay(date, from)
  })
  store.tracking.endSegment(segment.id, atMinuteOfDay(date, to))
  store.tracking.endRun(run.id, atMinuteOfDay(date, to))
}

describe('weekly aggregation', () => {
  it('joins planned and actual minutes per task', () => {
    const task = store.tasks.create({ title: 'Model training' })
    planBlock(task.id, monday, 540, 720) // 3h
    logSession(task.id, monday, 540, 690) // 2h30

    const report = reports.build(week)
    const row = report.rows.find((r) => r.taskTitle === 'Model training')!

    expect(row.plannedMin).toBe(180)
    expect(row.actualMin).toBe(150)
    expect(report.totalPlannedMin).toBe(180)
    expect(report.totalTrackedMin).toBe(150)
  })

  it('includes work that was never planned', () => {
    const task = store.tasks.create({ title: 'Unplanned firefighting' })
    logSession(task.id, monday, 600, 660)

    const report = reports.build(week)
    const row = report.rows.find((r) => r.taskTitle === 'Unplanned firefighting')!
    expect(row.plannedMin).toBe(0)
    expect(row.actualMin).toBe(60)
  })

  it('includes plans that were never worked on', () => {
    const task = store.tasks.create({ title: 'Never got to it' })
    planBlock(task.id, monday, 540, 600)

    const report = reports.build(week)
    const row = report.rows.find((r) => r.taskTitle === 'Never got to it')!
    expect(row.plannedMin).toBe(60)
    expect(row.actualMin).toBe(0)
  })

  it('only counts screenshots as included when they were approved', () => {
    const approved = store.artifacts.add({
      sessionId: null,
      day: monday,
      kind: 'screenshot',
      path: 'C:/frames/a.jpg',
      included: true
    })
    store.artifacts.add({
      sessionId: null,
      day: monday,
      kind: 'screenshot',
      path: 'C:/frames/b.jpg'
    })

    const report = reports.build(week)
    expect(report.screenshots).toHaveLength(2)
    expect(report.screenshots.filter((s) => s.included).map((s) => s.id)).toEqual([approved.id])
  })
})

// The snapshot's masking rules moved to services/snapshot.test.ts. The cases that used to
// live here drove the service through `store.sessions`, which nothing writes any more, so
// they proved the masking of a payload the app can no longer produce.
