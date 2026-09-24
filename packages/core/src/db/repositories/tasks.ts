import type { NewTask, Priority, Task, TaskFilter, TaskPatch } from '../../contract/types.js'
import { Db, newId } from '../connection.js'
import { MINUTE_MS } from '../../util/time.js'

interface TaskRow {
  id: string
  project_id: string | null
  project_name: string | null
  project_color: string | null
  area_id: string | null
  project_area_id: string | null
  project_organization_id: string | null
  work_type_id: string | null
  title: string
  priority: Priority
  status: Task['status']
  estimate_min: number | null
  due_date: string | null
  earliest_start_date: string | null
  postponed_count: number
  blocked_reason: string | null
  must_do_date: string | null
  sort_order: number
  created_at: number
  completed_at: number | null
  logged_ms: number | null
}

const SELECT = /* sql */ `
  SELECT
    t.*,
    p.name            AS project_name,
    p.color           AS project_color,
    p.area_id         AS project_area_id,
    -- Organization comes from the project and only from the project. It is carried here so
    -- filters can use it, never so that anything can read an area out of it.
    p.organization_id AS project_organization_id,
    -- Time segments are the single source of truth for actual time. Migration 005
    -- imported every legacy session, so nothing logged before the switch is lost.
    COALESCE((
      SELECT SUM(COALESCE(g.ended_at, ?) - g.started_at)
      FROM time_segments g
      WHERE g.task_id = t.id
    ), 0) AS logged_ms
  FROM tasks t
  LEFT JOIN projects p ON p.id = t.project_id
`

export class TaskRepo {
  constructor(private readonly db: Db) {}

  private map = (row: TaskRow): Task => ({
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    projectColor: row.project_color,
    // A task's own area wins; otherwise it inherits its project's.
    areaId: row.area_id ?? row.project_area_id,
    organizationId: row.project_organization_id,
    workTypeId: row.work_type_id,
    title: row.title,
    priority: row.priority,
    status: row.status,
    estimateMin: row.estimate_min,
    dueDate: row.due_date,
    earliestStartDate: row.earliest_start_date,
    postponedCount: row.postponed_count ?? 0,
    blockedReason: row.blocked_reason,
    mustDoDate: row.must_do_date,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    // A running segment counts toward the rollup — the number moves while you work.
    loggedMin: Math.round((row.logged_ms ?? 0) / MINUTE_MS)
  })

  list(filter: TaskFilter = {}): Task[] {
    const where: string[] = []
    const params: Array<string | number> = [Date.now()]

    if (filter.status === 'active') {
      // Everything still on your plate. Tracking a task moves it to 'in_progress', so
      // asking for exactly 'open' would hide the task you are working on right now.
      where.push("t.status IN ('open','in_progress','blocked')")
    } else if (filter.status) {
      where.push('t.status = ?')
      params.push(filter.status)
    }
    if (filter.projectId) {
      where.push('t.project_id = ?')
      params.push(filter.projectId)
    }
    if (filter.priority) {
      where.push('t.priority = ?')
      params.push(filter.priority)
    }
    if (filter.search) {
      where.push('t.title LIKE ?')
      params.push(`%${filter.search}%`)
    }

    const sql = `
      ${SELECT}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY
        CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
        t.sort_order,
        t.created_at
    `
    return this.db.all<TaskRow>(sql, params).map(this.map)
  }

  get(id: string): Task | null {
    const row = this.db.get<TaskRow>(`${SELECT} WHERE t.id = ?`, [Date.now(), id])
    return row ? this.map(row) : null
  }

  create(input: NewTask): Task {
    const id = newId()
    const now = Date.now()
    const nextOrder =
      (this.db.get<{ n: number | null }>('SELECT MAX(sort_order) AS n FROM tasks')?.n ?? 0) + 1

    this.db.run(
      `INSERT INTO tasks
         (id, project_id, area_id, work_type_id, title, priority, status, estimate_min,
          due_date, earliest_start_date, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
      [
        id,
        input.projectId ?? null,
        input.areaId ?? null,
        input.workTypeId ?? null,
        input.title.trim(),
        input.priority ?? 'medium',
        // null stays null: an unknown estimate is not zero, and no deadline is not a date.
        input.estimateMin ?? null,
        input.dueDate ?? null,
        input.earliestStartDate ?? null,
        nextOrder,
        now
      ]
    )
    return this.get(id)!
  }

  update(id: string, patch: TaskPatch): Task {
    const current = this.get(id)
    if (!current) throw new Error(`Task not found: ${id}`)

    const next = { ...current, ...patch }
    // Completing a task stamps completedAt; reopening clears it.
    const completedAt =
      next.status === 'done' ? (current.completedAt ?? Date.now()) : null

    // 'blocked' without a reason is not useful to anyone reading it later.
    const blockedReason = next.status === 'blocked' ? (next.blockedReason ?? 'blocked') : null

    this.db.run(
      `UPDATE tasks SET
         project_id = ?, area_id = ?, work_type_id = ?, title = ?, priority = ?, status = ?,
         estimate_min = ?, due_date = ?, earliest_start_date = ?, blocked_reason = ?,
         must_do_date = ?, sort_order = ?, completed_at = ?
       WHERE id = ?`,
      [
        next.projectId,
        patch.areaId !== undefined ? patch.areaId : current.areaId,
        next.workTypeId,
        next.title,
        next.priority,
        next.status,
        next.estimateMin,
        next.dueDate,
        next.earliestStartDate,
        blockedReason,
        next.mustDoDate,
        next.sortOrder,
        completedAt,
        id
      ]
    )
    return this.get(id)!
  }

  /** Raised when a planned block for this task is pushed to a later day. */
  incrementPostponed(id: string): void {
    this.db.run('UPDATE tasks SET postponed_count = postponed_count + 1 WHERE id = ?', [id])
  }

  complete(id: string, done: boolean): Task {
    return this.update(id, { status: done ? 'done' : 'open' })
  }

  remove(id: string): void {
    this.db.run('DELETE FROM tasks WHERE id = ?', [id])
  }

  countByStatus(): { open: number; done: number; dueToday: number } {
    const today = new Date()
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
      today.getDate()
    ).padStart(2, '0')}`
    const row = this.db.get<{ open: number; done: number; due_today: number }>(
      `SELECT
         SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
         SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
         SUM(CASE WHEN status = 'open' AND due_date = ? THEN 1 ELSE 0 END) AS due_today
       FROM tasks`,
      [iso]
    )
    return { open: row?.open ?? 0, done: row?.done ?? 0, dueToday: row?.due_today ?? 0 }
  }
}
