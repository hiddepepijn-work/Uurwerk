/**
 * How much work a task still needs.
 *
 * The interesting case is the task with no estimate. Treating "unknown" as zero makes it
 * invisible to the planner; treating it as some invented number pretends to knowledge
 * nobody has. Instead it gets a *discovery block* — a bounded slot whose job is to find
 * out how long the thing actually takes, after which you are asked for a real estimate.
 */

import type { PlanningProfile, Task } from '../../contract/types.js'

export interface Effort {
  /** Minutes still to do, or null when the estimate is unknown. */
  remainingMin: number | null
  /** True when this is a discovery block rather than the real work. */
  isDiscovery: boolean
  /** What the planner should actually reserve. */
  scheduleMin: number
  /** Already logged against the task. */
  loggedMin: number
  /** The estimate looks wrong: more time logged than was ever estimated. */
  overrun: boolean
}

export function remainingEffort(task: Task, profile: PlanningProfile): Effort {
  const loggedMin = Math.max(0, task.loggedMin)

  if (task.estimateMin === null) {
    // Unknown length. Reserve one discovery block — no more, however long it may turn
    // out to be, because scheduling around a guess is worse than scheduling around a
    // question. If time has already gone in, the block is what remains of it.
    const spentOnDiscovery = Math.min(loggedMin, profile.discoveryBlockMin)
    const scheduleMin = Math.max(profile.minimumBlockMin, profile.discoveryBlockMin - spentOnDiscovery)

    return {
      remainingMin: null,
      isDiscovery: true,
      scheduleMin,
      loggedMin,
      overrun: false
    }
  }

  const remainingMin = Math.max(0, task.estimateMin - loggedMin)

  return {
    remainingMin,
    isDiscovery: false,
    scheduleMin: remainingMin,
    loggedMin,
    overrun: loggedMin > task.estimateMin
  }
}

/**
 * Whether a task still needs time at all. A finished estimate with no deadline pressure
 * is not worth a block; the user can always start it by hand.
 */
export function needsTime(task: Task, profile: PlanningProfile): boolean {
  const effort = remainingEffort(task, profile)
  return effort.isDiscovery || effort.scheduleMin > 0
}

/**
 * Splits work into focus blocks.
 *
 * Long work is broken into chunks the profile calls comfortable rather than dropped in as
 * one six-hour slab, and a leftover too small to be useful is folded into the previous
 * block instead of becoming a ten-minute orphan.
 */
export function splitIntoBlocks(minutes: number, profile: PlanningProfile): number[] {
  if (minutes <= profile.maximumBlockMin) return [Math.max(profile.minimumBlockMin, minutes)]

  const blocks: number[] = []
  let left = minutes

  while (left > 0) {
    const chunk = Math.min(profile.preferredBlockMin, left)
    left -= chunk

    if (left > 0 && left < profile.minimumBlockMin) {
      // The tail is too small to stand alone: give it to the block before it.
      blocks.push(chunk + left)
      left = 0
    } else {
      blocks.push(chunk)
    }
  }

  return blocks
}
