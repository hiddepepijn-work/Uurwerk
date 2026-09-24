/**
 * Week planning: the grid, the unscheduled panel, and the planned-vs-actual comparison
 * that is the most useful thing in the whole report.
 */

import type { IsoWeek, PlannedBlock, PlannedVsActual, Task } from '../contract/types.js'
import type { Store } from '../db/index.js'
import { weekRange } from '../util/time.js'
import { StatsService } from './stats.js'

export class PlanningService {
  constructor(
    private readonly store: Store,
    private readonly stats: StatsService
  ) {}

  /**
   * The week's task blocks, flattened for anything that only wants "what is scheduled".
   *
   * Reads the accepted day plans, not the pre-planner `planned` table. That table stopped
   * being written the moment the versioned plan model landed, so this used to return an
   * empty list — which showed up as a report whose "planning komende week" section was
   * always blank and an unscheduled panel that listed every task you had ever made.
   */
  week(week: IsoWeek): PlannedBlock[] {
    return this.weekBlocks(week)
      .filter((block) => block.kind === 'task' && block.taskId !== null)
      .map((block) => ({
        id: block.id,
        taskId: block.taskId!,
        taskTitle: block.taskTitle ?? block.title ?? '',
        projectName: block.projectName,
        projectColor: block.projectColor,
        date: block.date,
        startMin: block.startMin,
        endMin: block.endMin
      }))
  }

  /** Blocks from the accepted day plans of a week — the versioned model, not `planned`. */
  weekBlocks(week: IsoWeek) {
    return this.store.plans.acceptedBlocksForDays(weekRange(week).days)
  }

  /** Open tasks with no block in this week — the right-hand drag source. */
  unscheduled(week: IsoWeek): Task[] {
    const scheduled = new Set(this.week(week).map((block) => block.taskId))
    return this.store.tasks.list({ status: 'active' }).filter((task) => !scheduled.has(task.id))
  }

  /**
   * Joins planned minutes and tracked minutes per task.
   * Includes tasks that were only planned (never worked) *and* tasks that were only worked
   * (never planned) — both cases are exactly what a supervisor wants to see.
   */
  plannedVsActual(week: IsoWeek): PlannedVsActual[] {
    // Planned time comes from the accepted day plans; actual comes from time segments.
    // Two independent sources on purpose — that is the comparison.
    const days = weekRange(week).days
    const baseline = this.store.plans.baselineMinutesForDays(days)
    const planned = this.store.plans.plannedMinutesForDays(days)
    const actual = this.stats.actualMinutesByTask(week)

    const taskIds = new Set([...baseline.keys(), ...planned.keys(), ...actual.keys()])
    const rows: PlannedVsActual[] = []

    for (const taskId of taskIds) {
      const task = this.store.tasks.get(taskId)
      if (!task) continue
      const plannedMin = planned.get(taskId) ?? 0
      const actualMin = actual.get(taskId) ?? 0
      rows.push({
        taskId,
        taskTitle: task.title,
        projectName: task.projectName,
        baselineMin: baseline.get(taskId) ?? 0,
        plannedMin,
        actualMin,
        deltaMin: actualMin - plannedMin
      })
    }

    // Most time spent first — that is the order the week is best explained in.
    return rows.sort((a, b) => b.actualMin - a.actualMin)
  }
}
