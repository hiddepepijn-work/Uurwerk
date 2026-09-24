import type { NewProject, Project } from '../../contract/types.js'
import { Db, fromDbBool, newId, toDbBool } from '../connection.js'

interface ProjectRow {
  id: string
  name: string
  color: string
  area_id: string | null
  organization_id: string | null
  shareable: number
  archived: number
}

const map = (row: ProjectRow): Project => ({
  id: row.id,
  name: row.name,
  color: row.color,
  areaId: row.area_id,
  organizationId: row.organization_id,
  shareable: fromDbBool(row.shareable),
  archived: fromDbBool(row.archived)
})

const DEFAULT_COLOR = '#1B3A5C'

export class ProjectRepo {
  constructor(private readonly db: Db) {}

  list(includeArchived = false): Project[] {
    const sql = includeArchived
      ? 'SELECT * FROM projects ORDER BY name COLLATE NOCASE'
      : 'SELECT * FROM projects WHERE archived = 0 ORDER BY name COLLATE NOCASE'
    return this.db.all<ProjectRow>(sql).map(map)
  }

  get(id: string): Project | null {
    const row = this.db.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', [id])
    return row ? map(row) : null
  }

  create(input: NewProject): Project {
    const project: Project = {
      id: newId(),
      name: input.name.trim(),
      color: input.color ?? DEFAULT_COLOR,
      areaId: input.areaId ?? null,
      // Independent of the area, and never inferred from it: the same organization can host
      // internship work and work that is not.
      organizationId: input.organizationId ?? null,
      // Default to NOT shareable. Opting in is a deliberate act, never a default.
      shareable: input.shareable ?? false,
      archived: false
    }
    this.db.run(
      `INSERT INTO projects (id, name, color, area_id, organization_id, shareable, archived)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        project.id,
        project.name,
        project.color,
        project.areaId,
        project.organizationId,
        toDbBool(project.shareable),
        0
      ]
    )
    return project
  }

  update(id: string, patch: Partial<Project>): Project {
    const current = this.get(id)
    if (!current) throw new Error(`Project not found: ${id}`)

    const next: Project = { ...current, ...patch, id }
    this.db.run(
      `UPDATE projects SET name = ?, color = ?, area_id = ?, organization_id = ?,
         shareable = ?, archived = ?
       WHERE id = ?`,
      [
        next.name,
        next.color,
        next.areaId,
        next.organizationId,
        toDbBool(next.shareable),
        toDbBool(next.archived),
        id
      ]
    )
    return next
  }

  setShareable(id: string, shareable: boolean): void {
    this.db.run('UPDATE projects SET shareable = ? WHERE id = ?', [toDbBool(shareable), id])
  }
}
