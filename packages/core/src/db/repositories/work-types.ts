import type { NewWorkType, WorkType } from '../../contract/types.js'
import { Db, fromDbBool, newId } from '../connection.js'
import { toSlug } from './organizations.js'

interface WorkTypeRow {
  id: string
  slug: string
  name: string
  sort_order: number
  archived: number
}

const map = (row: WorkTypeRow): WorkType => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  sortOrder: row.sort_order,
  archived: fromDbBool(row.archived)
})

/**
 * What an activity is.
 *
 * One record per kind of work, reused across every area and organization. There is no
 * `stage_research` and no `school_research`: there is `research`, and the area says which
 * of those it was.
 */
export class WorkTypeRepo {
  constructor(private readonly db: Db) {}

  list(includeArchived = false): WorkType[] {
    const sql = includeArchived
      ? 'SELECT * FROM work_types ORDER BY sort_order, name COLLATE NOCASE'
      : 'SELECT * FROM work_types WHERE archived = 0 ORDER BY sort_order, name COLLATE NOCASE'
    return this.db.all<WorkTypeRow>(sql).map(map)
  }

  get(id: string): WorkType | null {
    const row = this.db.get<WorkTypeRow>('SELECT * FROM work_types WHERE id = ?', [id])
    return row ? map(row) : null
  }

  bySlug(slug: string): WorkType | null {
    const row = this.db.get<WorkTypeRow>('SELECT * FROM work_types WHERE slug = ?', [slug])
    return row ? map(row) : null
  }

  create(input: NewWorkType): WorkType {
    const name = input.name.trim()
    if (!name) throw new Error('A work type needs a name.')

    const slug = input.slug?.trim() || toSlug(name)
    const existing = this.bySlug(slug)
    if (existing) throw new Error(`A work type called "${existing.name}" already exists.`)

    const nextOrder =
      (this.db.get<{ n: number | null }>('SELECT MAX(sort_order) AS n FROM work_types')?.n ?? 0) + 1

    const id = input.id ?? newId()
    this.db.run(
      'INSERT INTO work_types (id, slug, name, sort_order, archived) VALUES (?, ?, ?, ?, 0)',
      [id, slug, name, nextOrder]
    )
    return this.get(id)!
  }

  /** Archiving keeps history readable: tasks already labelled with it keep their label. */
  archive(id: string): void {
    this.db.run('UPDATE work_types SET archived = 1 WHERE id = ?', [id])
  }
}
