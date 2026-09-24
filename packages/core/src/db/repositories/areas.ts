import type { Area, NewArea } from '../../contract/types.js'
import { SYSTEM_AREAS } from '../../contract/types.js'
import { Db, fromDbBool, newId, toDbBool } from '../connection.js'

interface AreaRow {
  id: string
  name: string
  color: string
  counts_as_stage_hours: number
  default_share_supervisor: number
  default_share_teacher: number
  sort_order: number
  archived: number
}

const map = (row: AreaRow): Area => ({
  id: row.id,
  name: row.name,
  color: row.color,
  countsAsStageHours: fromDbBool(row.counts_as_stage_hours),
  defaultShareSupervisor: fromDbBool(row.default_share_supervisor),
  defaultShareTeacher: fromDbBool(row.default_share_teacher),
  sortOrder: row.sort_order,
  archived: fromDbBool(row.archived)
})

/** The three built-in areas cannot be deleted — too much history hangs off their ids. */
const SYSTEM_IDS: string[] = Object.values(SYSTEM_AREAS)

export class AreaRepo {
  constructor(private readonly db: Db) {}

  list(includeArchived = false): Area[] {
    const sql = includeArchived
      ? 'SELECT * FROM areas ORDER BY sort_order, name'
      : 'SELECT * FROM areas WHERE archived = 0 ORDER BY sort_order, name'
    return this.db.all<AreaRow>(sql).map(map)
  }

  get(id: string): Area | null {
    const row = this.db.get<AreaRow>('SELECT * FROM areas WHERE id = ?', [id])
    return row ? map(row) : null
  }

  /** Convenience for the many callers that only need the sharing and hour rules. */
  byId(): Map<string, Area> {
    return new Map(this.list(true).map((area) => [area.id, area]))
  }

  create(input: NewArea): Area {
    const nextOrder =
      (this.db.get<{ n: number | null }>('SELECT MAX(sort_order) AS n FROM areas')?.n ?? 0) + 1

    const area: Area = {
      id: input.id ?? newId(),
      name: input.name.trim(),
      color: input.color ?? '#1B3A5C',
      countsAsStageHours: input.countsAsStageHours ?? false,
      // Privacy by default: a new area shares with nobody until it is told to.
      defaultShareSupervisor: input.defaultShareSupervisor ?? false,
      defaultShareTeacher: input.defaultShareTeacher ?? false,
      sortOrder: nextOrder,
      archived: false
    }

    this.db.run(
      `INSERT INTO areas
         (id, name, color, counts_as_stage_hours, default_share_supervisor,
          default_share_teacher, sort_order, archived)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        area.id,
        area.name,
        area.color,
        toDbBool(area.countsAsStageHours),
        toDbBool(area.defaultShareSupervisor),
        toDbBool(area.defaultShareTeacher),
        area.sortOrder
      ]
    )
    return area
  }

  /**
   * Changing `countsAsStageHours` affects future segments only. Segments already recorded
   * keep their own snapshot of the rule, so past hours never silently reclassify.
   */
  update(id: string, patch: Partial<Area>): Area {
    const current = this.get(id)
    if (!current) throw new Error(`Area not found: ${id}`)

    const next: Area = { ...current, ...patch, id }
    this.db.run(
      `UPDATE areas SET
         name = ?, color = ?, counts_as_stage_hours = ?, default_share_supervisor = ?,
         default_share_teacher = ?, sort_order = ?, archived = ?
       WHERE id = ?`,
      [
        next.name,
        next.color,
        toDbBool(next.countsAsStageHours),
        toDbBool(next.defaultShareSupervisor),
        toDbBool(next.defaultShareTeacher),
        next.sortOrder,
        toDbBool(next.archived),
        id
      ]
    )
    return next
  }

  archive(id: string): void {
    if (SYSTEM_IDS.includes(id)) {
      throw new Error('The built-in areas Stage, Work and Personal cannot be removed.')
    }
    this.db.run('UPDATE areas SET archived = 1 WHERE id = ?', [id])
  }
}
