/**
 * ★ SECURITY-CRITICAL ★
 *
 * This builds the ONLY payload that ever leaves the machine over the network.
 *
 * Hard rules, enforced here rather than at the call site so they cannot be forgotten:
 *   1. No image ever appears in a snapshot. No paths, no filenames, no thumbnails.
 *   2. No session notes. Notes are written for you, not for a public page.
 *   3. A name — task or project — appears only when BOTH its area and its project allow
 *      sharing with the supervisor. Everything else collapses into "Overig werk" with its
 *      minutes still counted, so the totals stay honest without leaking what the work was.
 *   4. A task with no area is treated as NOT shareable. Absence of a rule is not permission.
 *   5. Only stage hours are reported. Time in Work or Personal is not the supervisor's
 *      business, so it is not in the payload at all — not even as a total.
 *
 * If you are about to add a field to PublicSnapshot, ask whether you would be comfortable
 * with it being screenshotted into a group chat. That is the actual threat model.
 */

import type { Area, PublicSnapshot, Task } from '../contract/types.js'
import type { Store } from '../db/index.js'
import { resolveAreaId, sharesWithSupervisor } from '../domain/sharing.js'
import { dayRange, toIsoDate, toIsoWeek, weekRange } from '../util/time.js'
import { StatsService } from './stats.js'

export const MASKED_LABEL = 'Overig werk'

export class SnapshotService {
  constructor(
    private readonly store: Store,
    private readonly stats: StatsService
  ) {}

  build(now = Date.now()): PublicSnapshot {
    const today = toIsoDate(now)
    const week = toIsoWeek(now)
    const { startMs, endMs, days } = weekRange(week)
    const dayBounds = dayRange(today)

    // Segments, not sessions: `sessions` stopped being written when tracking moved to runs,
    // so reading it here reported "not tracking" no matter what was actually running.
    const running = this.store.tracking.currentSegment()
    const settings = this.store.settings.get()
    const areas = this.store.areas.byId()

    // Planned minutes come from the accepted day plans — the versioned model. The old flat
    // `planned` table has not been written to since the planner landed.
    let plannedMin = 0
    for (const minutes of this.store.plans.plannedMinutesForDays(days).values()) {
      plannedMin += minutes
    }

    const shareableTasks = this.store.tasks
      .list()
      .filter((task) => this.sharesWithSupervisor(task, areas))

    const completedThisWeek = shareableTasks.filter(
      (task) =>
        task.status === 'done' &&
        task.completedAt !== null &&
        task.completedAt >= startMs &&
        task.completedAt < endMs
    ).length

    return {
      updatedAt: now,
      // Rule 5: working on something private reads as not tracking, because as far as the
      // supervisor view is concerned, no internship time is being spent.
      tracking: running !== null && running.countsAsStageHours,
      ...this.maskCurrent(running?.taskId ?? null, running?.countsAsStageHours ?? false, areas),
      todayStageMin: this.stats.totals(dayBounds.startMs, dayBounds.endMs).stageMin,
      weekStageMin: this.stats.totals(startMs, endMs).stageMin,
      weekPlannedMin: plannedMin,
      weekGoalMin: settings.weeklyGoalMin,
      openTasks: shareableTasks.filter(
        (task) => task.status !== 'done' && task.status !== 'archived'
      ).length,
      completedThisWeek
    }
  }

  /**
   * Rules 3 and 4 live here. Both fields are decided together so they can never disagree.
   *
   * The area is the hard boundary and the project can only narrow it further, which is the
   * whole point of having two: flipping a project to shareable cannot publish work from an
   * area you never agreed to share.
   */
  private maskCurrent(
    taskId: string | null,
    countsAsStageHours: boolean,
    areas: Map<string, Area>
  ): { currentTask: string | null; currentProject: string | null } {
    if (!taskId || !countsAsStageHours) return { currentTask: null, currentProject: null }

    const task = this.store.tasks.get(taskId)
    if (!task) return { currentTask: null, currentProject: null }

    if (!this.sharesWithSupervisor(task, areas)) {
      return { currentTask: MASKED_LABEL, currentProject: null }
    }

    const project = task.projectId ? this.store.projects.get(task.projectId) : null
    return { currentTask: task.title, currentProject: project?.name ?? null }
  }

  private sharesWithSupervisor(task: Task, areas: Map<string, Area>): boolean {
    const project = task.projectId ? this.store.projects.get(task.projectId) : null
    const areaId = resolveAreaId(task, project)
    return sharesWithSupervisor({
      area: areaId ? (areas.get(areaId) ?? null) : null,
      project
    })
  }
}
