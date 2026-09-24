/**
 * Editing a plan block, with the bookkeeping that goes with it.
 *
 * The repository writes rows; this decides what a write *means*. Moving a block to a later
 * day is the one edit that says something about the task rather than about the calendar:
 * it has been put off. Counting that is what lets the planner push back on work that keeps
 * drifting, instead of politely rescheduling it for ever.
 *
 * It lives in core rather than in the IPC handler so the rule can be tested without an
 * Electron process, and so the supervisor's web view would get the same behaviour.
 */

import type { NewPlanBlock, PlanBlock } from '../contract/types.js'
import type { Store } from '../db/index.js'

export class PlanEditService {
  constructor(private readonly store: Store) {}

  /**
   * Applies a patch to a block.
   *
   * A move to a later date raises the task's postponed count. Moving it earlier, or
   * anywhere within the same day, does not — dragging a block from 10:00 to 14:00 is
   * planning, not postponing, and treating it as postponing would make the number
   * meaningless within a week.
   */
  updateBlock(id: string, patch: Partial<NewPlanBlock>): PlanBlock {
    const current = this.store.plans.getBlock(id)
    if (!current) throw new Error(`Plan block not found: ${id}`)

    return this.store.db.transaction(() => {
      const updated = this.store.plans.updateBlock(id, patch)

      if (updated.taskId && updated.date > current.date) {
        this.store.tasks.incrementPostponed(updated.taskId)
      }

      return updated
    })
  }
}
