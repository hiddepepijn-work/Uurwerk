/**
 * Which tasks are even eligible to be scheduled.
 *
 * Constraints first, preferences later. A task excluded here is not "low priority" — it
 * genuinely cannot be worked on, and no score should ever be able to promote it into the
 * plan. Keeping that separation is what stops the scheduler from producing a plan that
 * looks reasonable and is impossible.
 */

import type { IsoDate, PlanningProfile, Task } from '../../contract/types.js'
import type { DependencyGraph } from './dependency-graph.js'
import { needsTime } from './remaining-effort.js'

export type ExclusionReason =
  | 'done'
  | 'archived'
  | 'blocked'
  | 'waiting-on-dependency'
  | 'not-startable-yet'
  | 'no-time-needed'

export interface Candidate {
  task: Task
  /** Unfinished tasks this one would free up, following the chain. */
  unlockValue: number
  /** Unfinished preferred prerequisites: schedule after these when possible. */
  prefersAfter: string[]
  /**
   * Unfinished *hard* prerequisites that are themselves being scheduled in this run.
   *
   * Empty for the day planner, which cannot schedule a prerequisite and its dependant on the
   * same day and so excludes the dependant outright. Non-empty only under `deferBlocked`,
   * where the caller has promised to place this task after everything listed here.
   */
  mustFollow: string[]
}

export interface Excluded {
  task: Task
  reason: ExclusionReason
  /** Written for a human, shown next to the task in the planner. */
  explanation: string
}

export interface FilterResult {
  candidates: Candidate[]
  excluded: Excluded[]
}

export function filterCandidates(input: {
  tasks: Task[]
  graph: DependencyGraph
  profile: PlanningProfile
  /** The day being planned; a task cannot start before its earliest start date. */
  date: IsoDate
  /**
   * Keep a hard-blocked task as a candidate when its blockers are being scheduled too.
   *
   * Off for a single day, where it would be a lie: finishing the prerequisite and starting
   * the dependant in the same eight hours is not something the planner can promise.
   *
   * On across a range, where dropping them is the worse lie. A chain of eight chapters has
   * exactly one schedulable task at any moment, so a fortnight plan came back holding three
   * hours of work and seven empty days — while the planner knew perfectly well when chapter
   * six would be finished and could have laid the rest out behind it.
   */
  deferBlocked?: boolean
}): FilterResult {
  const candidates: Candidate[] = []
  const excluded: Excluded[] = []

  /**
   * Everything that could be worked on if dependencies did not exist.
   *
   * A blocked task may only be deferred behind a prerequisite that is itself going to be
   * scheduled. Waiting on something archived, blocked or already out of time is not an
   * ordering problem — it is a genuine dead end, and it stays excluded.
   */
  const schedulableIgnoringDependencies = new Set(
    input.tasks
      .filter(
        (task) =>
          task.status !== 'done' &&
          task.status !== 'archived' &&
          task.status !== 'blocked' &&
          !(task.earliestStartDate && task.earliestStartDate > input.date) &&
          needsTime(task, input.profile)
      )
      .map((task) => task.id)
  )

  for (const task of input.tasks) {
    if (task.status === 'done') {
      excluded.push({ task, reason: 'done', explanation: 'Already finished.' })
      continue
    }
    if (task.status === 'archived') {
      excluded.push({ task, reason: 'archived', explanation: 'Archived.' })
      continue
    }
    if (task.status === 'blocked') {
      excluded.push({
        task,
        reason: 'blocked',
        explanation: task.blockedReason
          ? `Blocked: ${task.blockedReason}.`
          : 'Marked as blocked.'
      })
      continue
    }

    const blockers = input.graph.blockedBy(task.id)
    const deferrable =
      input.deferBlocked &&
      blockers.every((edge) => schedulableIgnoringDependencies.has(edge.dependsOnTaskId))

    if (blockers.length > 0 && !deferrable) {
      excluded.push({
        task,
        reason: 'waiting-on-dependency',
        explanation:
          blockers.length === 1
            ? 'Waiting on another task that is not finished.'
            : `Waiting on ${blockers.length} unfinished tasks.`
      })
      continue
    }

    if (task.earliestStartDate && task.earliestStartDate > input.date) {
      excluded.push({
        task,
        reason: 'not-startable-yet',
        explanation: `Cannot start before ${task.earliestStartDate}.`
      })
      continue
    }

    if (!needsTime(task, input.profile)) {
      excluded.push({
        task,
        reason: 'no-time-needed',
        explanation: 'The estimate is already used up — finish it or re-estimate.'
      })
      continue
    }

    candidates.push({
      task,
      unlockValue: input.graph.unlockValue(task.id),
      prefersAfter: input.graph.prefersAfter(task.id).map((edge) => edge.dependsOnTaskId),
      mustFollow: blockers.map((edge) => edge.dependsOnTaskId)
    })
  }

  return { candidates, excluded }
}
