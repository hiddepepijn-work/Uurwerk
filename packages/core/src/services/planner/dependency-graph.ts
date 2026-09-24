/**
 * The dependency graph, as the planner needs to see it.
 *
 * Two questions get asked constantly while scheduling: "may this task be started at all?"
 * and "how much does finishing it unlock?". Both are answered from one snapshot of the
 * edges, built once per planning run rather than queried per task — a scheduler that hits
 * the database inside its inner loop gets slow in a way that is hard to undo later.
 */

import type { DependencyType, Task, TaskStatus } from '../../contract/types.js'

export interface DependencyEdge {
  taskId: string
  dependsOnTaskId: string
  type: DependencyType
}

const DONE: TaskStatus[] = ['done', 'archived']

export class DependencyGraph {
  /** task -> what it waits for */
  private readonly requires = new Map<string, DependencyEdge[]>()
  /** task -> what waits for it */
  private readonly unlocks = new Map<string, DependencyEdge[]>()
  private readonly statusById = new Map<string, TaskStatus>()

  constructor(tasks: Task[], edges: DependencyEdge[]) {
    for (const task of tasks) this.statusById.set(task.id, task.status)

    for (const edge of edges) {
      const requires = this.requires.get(edge.taskId)
      if (requires) requires.push(edge)
      else this.requires.set(edge.taskId, [edge])

      const unlocks = this.unlocks.get(edge.dependsOnTaskId)
      if (unlocks) unlocks.push(edge)
      else this.unlocks.set(edge.dependsOnTaskId, [edge])
    }
  }

  /**
   * Hard prerequisites that are not finished. A non-empty result means the task cannot be
   * scheduled at all — not "should be scheduled later", but "cannot start".
   */
  blockedBy(taskId: string): DependencyEdge[] {
    return (this.requires.get(taskId) ?? []).filter(
      (edge) => edge.type === 'hard' && !this.isSettled(edge.dependsOnTaskId)
    )
  }

  isBlocked(taskId: string): boolean {
    return this.blockedBy(taskId).length > 0
  }

  /** Preferred prerequisites that are not finished: an ordering hint, never a block. */
  prefersAfter(taskId: string): DependencyEdge[] {
    return (this.requires.get(taskId) ?? []).filter(
      (edge) => edge.type === 'preferred' && !this.isSettled(edge.dependsOnTaskId)
    )
  }

  /**
   * How many unfinished tasks finishing this one would eventually free, following the
   * chain rather than counting only direct dependents. A task nothing waits for scores
   * zero here, however urgent it is in its own right.
   */
  unlockValue(taskId: string): number {
    const seen = new Set<string>()
    const queue = [...(this.unlocks.get(taskId) ?? [])].map((edge) => edge.taskId)

    while (queue.length > 0) {
      const next = queue.pop()!
      if (seen.has(next) || this.isSettled(next)) continue
      seen.add(next)
      queue.push(...(this.unlocks.get(next) ?? []).map((edge) => edge.taskId))
    }
    return seen.size
  }

  /**
   * Orders tasks so prerequisites come first — a topological sort that tolerates cycles
   * by falling back to the input order for anything it cannot place. Cycles are rejected
   * at write time, but the planner must not hang if one ever slips through.
   */
  inDependencyOrder(tasks: Task[]): Task[] {
    const byId = new Map(tasks.map((task) => [task.id, task]))
    const placed = new Set<string>()
    const out: Task[] = []

    const visit = (task: Task, trail: Set<string>): void => {
      if (placed.has(task.id) || trail.has(task.id)) return
      trail.add(task.id)

      for (const edge of this.requires.get(task.id) ?? []) {
        const prerequisite = byId.get(edge.dependsOnTaskId)
        if (prerequisite && !this.isSettled(prerequisite.id)) visit(prerequisite, trail)
      }

      trail.delete(task.id)
      placed.add(task.id)
      out.push(task)
    }

    for (const task of tasks) visit(task, new Set())
    return out
  }

  private isSettled(taskId: string): boolean {
    const status = this.statusById.get(taskId)
    // An unknown task cannot be waited on; treating it as settled avoids a permanent block.
    return status === undefined || DONE.includes(status)
  }
}
