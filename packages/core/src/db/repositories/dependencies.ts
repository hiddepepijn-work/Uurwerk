import type { DependencyType, TaskDependency, TaskStatus } from '../../contract/types.js'
import { Db } from '../connection.js'

interface DependencyRow {
  task_id: string
  depends_on_task_id: string
  depends_on_title: string
  depends_on_status: TaskStatus
  type: DependencyType
}

const map = (row: DependencyRow): TaskDependency => ({
  taskId: row.task_id,
  dependsOnTaskId: row.depends_on_task_id,
  dependsOnTitle: row.depends_on_title,
  dependsOnStatus: row.depends_on_status,
  type: row.type
})

const SELECT = /* sql */ `
  SELECT
    d.*,
    t.title  AS depends_on_title,
    t.status AS depends_on_status
  FROM task_dependencies d
  JOIN tasks t ON t.id = d.depends_on_task_id
`

/** Thrown for a cycle so callers can show the chain rather than a generic failure. */
export class DependencyCycleError extends Error {
  constructor(readonly chain: string[]) {
    super(`Adding this dependency would create a cycle: ${chain.join(' -> ')}`)
    this.name = 'DependencyCycleError'
  }
}

export class DependencyRepo {
  constructor(private readonly db: Db) {}

  /** What this task waits for. */
  forTask(taskId: string): TaskDependency[] {
    return this.db.all<DependencyRow>(`${SELECT} WHERE d.task_id = ?`, [taskId]).map(map)
  }

  /** What waits for this task — the basis of its unlock value. */
  dependents(taskId: string): TaskDependency[] {
    return this.db
      .all<DependencyRow>(
        `SELECT d.*, t.title AS depends_on_title, t.status AS depends_on_status
         FROM task_dependencies d
         JOIN tasks t ON t.id = d.task_id
         WHERE d.depends_on_task_id = ?`,
        [taskId]
      )
      .map(map)
  }

  /**
   * Every edge, with the prerequisite's title and status.
   *
   * `all()` is the planner's shape — ids only, because it builds its own status map. This
   * one is the UI's: a list can only say "waiting on two unfinished tasks" if it knows
   * which of them are finished.
   */
  allDetailed(): TaskDependency[] {
    return this.db.all<DependencyRow>(SELECT).map(map)
  }

  all(): Array<{ taskId: string; dependsOnTaskId: string; type: DependencyType }> {
    return this.db
      .all<{ task_id: string; depends_on_task_id: string; type: DependencyType }>(
        'SELECT task_id, depends_on_task_id, type FROM task_dependencies'
      )
      .map((row) => ({
        taskId: row.task_id,
        dependsOnTaskId: row.depends_on_task_id,
        type: row.type
      }))
  }

  /**
   * Adds an edge, refusing anything that would create a cycle.
   *
   * The check runs before the insert rather than after, because a cycle in the dependency
   * graph makes the planner non-terminating — this is the one place where rejecting the
   * write is much cheaper than repairing the data later.
   */
  add(taskId: string, dependsOnTaskId: string, type: DependencyType = 'hard'): void {
    if (taskId === dependsOnTaskId) {
      throw new DependencyCycleError([taskId, taskId])
    }

    const chain = this.findPath(dependsOnTaskId, taskId)
    if (chain) throw new DependencyCycleError([...chain, dependsOnTaskId])

    this.db.run(
      `INSERT INTO task_dependencies (task_id, depends_on_task_id, type, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(task_id, depends_on_task_id) DO UPDATE SET type = excluded.type`,
      [taskId, dependsOnTaskId, type, Date.now()]
    )
  }

  remove(taskId: string, dependsOnTaskId: string): void {
    this.db.run(
      'DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?',
      [taskId, dependsOnTaskId]
    )
  }

  /** Replaces the whole set for one task, atomically, validating each edge. */
  setForTask(
    taskId: string,
    dependencies: Array<{ dependsOnTaskId: string; type: DependencyType }>
  ): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM task_dependencies WHERE task_id = ?', [taskId])
      for (const dependency of dependencies) {
        this.add(taskId, dependency.dependsOnTaskId, dependency.type)
      }
    })
  }

  /**
   * Hard prerequisites that are not done yet. A non-empty result means the task cannot be
   * scheduled or started at all.
   */
  unmetHardDependencies(taskId: string): TaskDependency[] {
    return this.db
      .all<DependencyRow>(
        `${SELECT}
         WHERE d.task_id = ?
           AND d.type = 'hard'
           AND t.status NOT IN ('done', 'archived')`,
        [taskId]
      )
      .map(map)
  }

  /**
   * How many tasks this one unblocks, following the chain rather than just direct
   * dependents. A task that unlocks several downstream tasks earns planning priority even
   * when its own deadline is comfortable.
   */
  unlockValue(taskId: string): number {
    const edges = this.all()
    const downstream = new Map<string, string[]>()
    for (const edge of edges) {
      const list = downstream.get(edge.dependsOnTaskId)
      if (list) list.push(edge.taskId)
      else downstream.set(edge.dependsOnTaskId, [edge.taskId])
    }

    const seen = new Set<string>()
    const queue = [...(downstream.get(taskId) ?? [])]
    while (queue.length > 0) {
      const next = queue.pop()!
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(...(downstream.get(next) ?? []))
    }
    return seen.size
  }

  /**
   * Depth-first search for a path from `from` to `to` through the dependency edges.
   * Returns the chain when one exists, which is what makes the error message readable.
   */
  private findPath(from: string, to: string): string[] | null {
    const edges = this.all()
    const outgoing = new Map<string, string[]>()
    for (const edge of edges) {
      const list = outgoing.get(edge.taskId)
      if (list) list.push(edge.dependsOnTaskId)
      else outgoing.set(edge.taskId, [edge.dependsOnTaskId])
    }

    const visited = new Set<string>()

    const walk = (node: string, path: string[]): string[] | null => {
      if (node === to) return [...path, node]
      if (visited.has(node)) return null
      visited.add(node)

      for (const next of outgoing.get(node) ?? []) {
        const found = walk(next, [...path, node])
        if (found) return found
      }
      return null
    }

    return walk(from, [])
  }
}
