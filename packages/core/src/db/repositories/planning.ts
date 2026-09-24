import type { IsoDate, NewPlannedBlock, PlannedBlock } from '../../contract/types.js'
import { Db, newId } from '../connection.js'

interface PlannedRow {
  id: string
  task_id: string
  task_title: string
  project_name: string | null
  project_color: string | null
  date: string
  start_min: number
  end_min: number
}

const SELECT = /* sql */ `
  SELECT
    b.*,
    t.title AS task_title,
    p.name  AS project_name,
    p.color AS project_color
  FROM planned b
  JOIN tasks t     ON t.id = b.task_id
  LEFT JOIN projects p ON p.id = t.project_id
`

const map = (row: PlannedRow): PlannedBlock => ({
  id: row.id,
  taskId: row.task_id,
  taskTitle: row.task_title,
  projectName: row.project_name,
  projectColor: row.project_color,
  date: row.date,
  startMin: row.start_min,
  endMin: row.end_min
})

export class PlanningRepo {
  constructor(private readonly db: Db) {}

  get(id: string): PlannedBlock | null {
    const row = this.db.get<PlannedRow>(`${SELECT} WHERE b.id = ?`, [id])
    return row ? map(row) : null
  }

  /** All blocks between two local dates, inclusive — one ISO week for the grid. */
  listBetween(from: IsoDate, to: IsoDate): PlannedBlock[] {
    return this.db
      .all<PlannedRow>(`${SELECT} WHERE b.date BETWEEN ? AND ? ORDER BY b.date, b.start_min`, [
        from,
        to
      ])
      .map(map)
  }

  listByTask(taskId: string): PlannedBlock[] {
    return this.db
      .all<PlannedRow>(`${SELECT} WHERE b.task_id = ? ORDER BY b.date, b.start_min`, [taskId])
      .map(map)
  }

  schedule(input: NewPlannedBlock): PlannedBlock {
    if (input.endMin <= input.startMin) {
      throw new Error('A planned block must end after it starts.')
    }
    const id = newId()
    this.db.run(
      'INSERT INTO planned (id, task_id, date, start_min, end_min) VALUES (?, ?, ?, ?, ?)',
      [id, input.taskId, input.date, input.startMin, input.endMin]
    )
    return this.get(id)!
  }

  move(id: string, date: IsoDate, startMin: number, endMin: number): PlannedBlock {
    if (endMin <= startMin) throw new Error('A planned block must end after it starts.')
    this.db.run('UPDATE planned SET date = ?, start_min = ?, end_min = ? WHERE id = ?', [
      date,
      startMin,
      endMin,
      id
    ])
    const block = this.get(id)
    if (!block) throw new Error(`Planned block not found: ${id}`)
    return block
  }

  unschedule(id: string): void {
    this.db.run('DELETE FROM planned WHERE id = ?', [id])
  }

  /** Planned minutes per task within a date range — one half of planned-vs-actual. */
  plannedMinutesByTask(from: IsoDate, to: IsoDate): Map<string, number> {
    const rows = this.db.all<{ task_id: string; minutes: number }>(
      `SELECT task_id, SUM(end_min - start_min) AS minutes
       FROM planned
       WHERE date BETWEEN ? AND ?
       GROUP BY task_id`,
      [from, to]
    )
    return new Map(rows.map((r) => [r.task_id, r.minutes]))
  }
}
