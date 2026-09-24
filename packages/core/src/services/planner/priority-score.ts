/**
 * The ranking, and why.
 *
 * Deliberately a transparent weighted sum rather than anything learned or opaque: every
 * term is named, bounded, and can be pointed at when the plan surprises you. A scheduler
 * you cannot argue with is a scheduler you stop trusting the first time it is wrong.
 *
 * Scores only order the tasks that are already *allowed* to be scheduled — constraints
 * are applied before this runs, never traded off against a number.
 */

import type { IsoDate, PlanningProfile, Priority, Task } from '../../contract/types.js'
import type { Candidate } from './candidate-filter.js'
import type { DayWindow } from './availability.js'
import { workingMinutesUntil } from './availability.js'
import { remainingEffort } from './remaining-effort.js'

/** Each term's maximum contribution. They sum to 100 so a score reads as a percentage. */
export const WEIGHTS = {
  deadline: 34,
  priority: 22,
  unlock: 14,
  mustDo: 10,
  postponed: 8,
  age: 5,
  fit: 4,
  context: 3
} as const

const PRIORITY_WEIGHT: Record<Priority, number> = { high: 1, medium: 0.55, low: 0.2 }

export interface ScoreTerm {
  label: string
  points: number
  /** One sentence, shown to the user. */
  detail: string
}

export interface ScoredTask {
  task: Task
  score: number
  terms: ScoreTerm[]
  /** Working minutes available before the deadline, minus what the task still needs. */
  slackMin: number | null
  /** No longer enough working time left before the deadline. */
  atRisk: boolean
  scheduleMin: number
  isDiscovery: boolean
}

export function scoreCandidates(input: {
  candidates: Candidate[]
  windows: DayWindow[]
  profile: PlanningProfile
  date: IsoDate
  /** The project worked on most recently, for the context-switch bonus. */
  recentProjectId?: string | null
  /** The largest free gap today, for the fit bonus. */
  largestGapMin?: number
}): ScoredTask[] {
  const now = Date.now()

  return input.candidates
    .map((candidate) => {
      const { task } = candidate
      const effort = remainingEffort(task, input.profile)
      const terms: ScoreTerm[] = []

      // ---------------------------------------------------------- deadline
      let slackMin: number | null = null
      let atRisk = false

      if (task.dueDate) {
        const availableMin = workingMinutesUntil(input.windows, task.dueDate)
        slackMin = availableMin - effort.scheduleMin
        atRisk = slackMin < 0

        // Pressure rises as slack shrinks; a task with no room left scores the maximum.
        const ratio = availableMin > 0 ? Math.max(0, Math.min(1, 1 - slackMin / availableMin)) : 1
        const points = Math.round(WEIGHTS.deadline * (atRisk ? 1 : ratio))

        terms.push({
          label: 'Deadline',
          points,
          detail: atRisk
            ? `Due ${task.dueDate}, and there is no longer enough working time left`
            : `Due ${task.dueDate}, ${Math.round(slackMin / 60)}h of slack`
        })
      } else {
        terms.push({ label: 'Deadline', points: 0, detail: 'No due date' })
      }

      // ---------------------------------------------------------- priority
      terms.push({
        label: 'Priority',
        points: Math.round(WEIGHTS.priority * PRIORITY_WEIGHT[task.priority]),
        detail: `${task.priority} priority`
      })

      // ------------------------------------------------------------ unlock
      if (candidate.unlockValue > 0) {
        // Saturates at three: unlocking ten things is not ten times as urgent as one.
        const points = Math.round(WEIGHTS.unlock * Math.min(1, candidate.unlockValue / 3))
        terms.push({
          label: 'Unlocks',
          points,
          detail:
            candidate.unlockValue === 1
              ? 'Unlocks one other task'
              : `Unlocks ${candidate.unlockValue} other tasks`
        })
      }

      // ---------------------------------------------------------- must do
      if (task.mustDoDate === input.date) {
        terms.push({ label: 'Must do', points: WEIGHTS.mustDo, detail: 'You marked this as a must-do today' })
      }

      // -------------------------------------------------------- postponed
      if (task.postponedCount > 0) {
        // Something pushed back repeatedly is either urgent or wrongly sized; either way
        // it should stop drifting quietly down the list.
        const points = Math.round(WEIGHTS.postponed * Math.min(1, task.postponedCount / 3))
        terms.push({
          label: 'Postponed',
          points,
          detail: `Moved to a later day ${task.postponedCount}×`
        })
      }

      // -------------------------------------------------------------- age
      const ageDays = Math.floor((now - task.createdAt) / 86_400_000)
      if (ageDays >= 3) {
        const points = Math.round(WEIGHTS.age * Math.min(1, ageDays / 14))
        terms.push({ label: 'Age', points, detail: `On the list for ${ageDays} days` })
      }

      // -------------------------------------------------------------- fit
      if (input.largestGapMin && effort.scheduleMin <= input.largestGapMin) {
        terms.push({
          label: 'Fits',
          points: WEIGHTS.fit,
          detail: 'Fits in today’s largest free block in one go'
        })
      }

      // ---------------------------------------------------------- context
      if (input.recentProjectId && task.projectId === input.recentProjectId) {
        terms.push({
          label: 'Same project',
          points: WEIGHTS.context,
          detail: 'Same project as the work before it, so no context switch'
        })
      }

      return {
        task,
        score: terms.reduce((sum, term) => sum + term.points, 0),
        terms,
        slackMin,
        atRisk,
        scheduleMin: effort.scheduleMin,
        isDiscovery: effort.isDiscovery
      }
    })
    .sort((a, b) => {
      // At-risk work first, whatever else the numbers say: missing a deadline is a
      // different kind of failure from doing something in a slightly worse order.
      if (a.atRisk !== b.atRisk) return a.atRisk ? -1 : 1
      return b.score - a.score
    })
}
