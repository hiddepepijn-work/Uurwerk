/**
 * Turns a week of raw rows into the report model.
 *
 * Everything the .docx and the Reports screen show comes from here, so the screen you
 * approve and the document your supervisor opens are guaranteed to hold the same numbers.
 */

import type { IsoWeek, ReportTaskRow, WeekReport } from '../contract/types.js'
import type { Store } from '../db/index.js'
import { nextWeek, weekRange } from '../util/time.js'
import { PlanningService } from '../services/planning.js'
import { StatsService } from '../services/stats.js'

export class ReportAggregator {
  constructor(
    private readonly store: Store,
    private readonly stats: StatsService,
    private readonly planning: PlanningService
  ) {}

  build(week: IsoWeek): WeekReport {
    const { from, to, startMs, endMs } = weekRange(week)
    const record = this.store.reports.ensure(week)

    const rows: ReportTaskRow[] = this.planning.plannedVsActual(week).map((row) => {
      const task = this.store.tasks.get(row.taskId)
      return {
        taskTitle: row.taskTitle,
        projectName: row.projectName,
        baselineMin: row.baselineMin,
        plannedMin: row.plannedMin,
        actualMin: row.actualMin,
        status: task?.status ?? 'open'
      }
    })

    const completedTasks = this.store.tasks
      .list({ status: 'done' })
      .filter((t) => t.completedAt !== null && t.completedAt >= startMs && t.completedAt < endMs)

    // The approval gate: the screen shows every frame, the document takes only `included`.
    const screenshots = this.store.artifacts.listBetween(from, to, 'screenshot')
    const timelapses = this.store.artifacts.listBetween(from, to, 'timelapse')

    return {
      week,
      from,
      to,
      generatedAt: record.generatedAt ?? Date.now(),
      rows,
      totalPlannedMin: rows.reduce((sum, r) => sum + r.plannedMin, 0),
      totalTrackedMin: this.stats.trackedMinutes(startMs, endMs),
      completedTasks: completedTasks.length,
      totalTasks: rows.length,
      screenshots,
      timelapse: timelapses[timelapses.length - 1] ?? null,
      summary: record.summary,
      nextWeekPlanning: this.planning.week(nextWeek(week)),
      docxPath: record.docxPath,
      sentAt: record.sentAt
    }
  }
}
