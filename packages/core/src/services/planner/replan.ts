/**
 * Replanning the rest of a day.
 *
 * The rule that makes this safe: **only future, unfinished blocks may move**. What has
 * already happened is history, what is running now is in progress, and what you locked is
 * a decision. Everything else is fair game.
 *
 * Getting this wrong would mean a plan that rewrites your morning at four in the
 * afternoon, which is exactly the behaviour that makes people stop trusting a planner.
 */

import type { PlanBlock } from '../../contract/types.js'

export interface ReplanSplit {
  /** Untouchable: already past, currently running, locked, or fixed. */
  keep: PlanBlock[]
  /** May be moved, resized or dropped. */
  movable: PlanBlock[]
}

export function splitForReplan(input: {
  blocks: PlanBlock[]
  /** Minutes since midnight; everything before this is history. */
  nowMin: number
  /** The block being worked on right now, if any. */
  activeBlockId?: string | null
}): ReplanSplit {
  const keep: PlanBlock[] = []
  const movable: PlanBlock[] = []

  for (const block of input.blocks) {
    const isPast = block.endMin <= input.nowMin
    const isRunning = block.startMin <= input.nowMin && block.endMin > input.nowMin
    const isActive = input.activeBlockId != null && block.id === input.activeBlockId

    if (isPast || isRunning || isActive || block.locked || block.fixed) keep.push(block)
    else movable.push(block)
  }

  return { keep, movable }
}

/**
 * How far behind the plan the day is running.
 *
 * Positive means work that should have been finished by now has not been. This is what
 * triggers the "you are 40 minutes behind — replan the rest of the day?" offer, which is
 * an offer rather than an action for the same reason as everything else here.
 */
export function minutesBehind(input: {
  blocks: PlanBlock[]
  nowMin: number
  /** Minutes actually tracked against each task today. */
  actualByTask: Map<string, number>
}): number {
  let plannedSoFar = 0

  for (const block of input.blocks) {
    if (block.kind !== 'task' || !block.taskId) continue
    // Count only the part of each block that should already have happened.
    const elapsed = Math.max(0, Math.min(block.endMin, input.nowMin) - block.startMin)
    plannedSoFar += elapsed
  }

  const actual = [...input.actualByTask.values()].reduce((sum, minutes) => sum + minutes, 0)
  return Math.max(0, plannedSoFar - actual)
}
