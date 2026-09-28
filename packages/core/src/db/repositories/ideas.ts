import type { Idea, IdeaStatus, NewIdea } from '../../contract/types.js'
import { Db, newId } from '../connection.js'

interface IdeaRow {
  id: string
  text: string
  project_id: string | null
  area_id: string | null
  status: IdeaStatus
  created_at: number
  updated_at: number
}

const mapIdea = (row: IdeaRow): Idea => ({
  id: row.id,
  text: row.text,
  projectId: row.project_id,
  areaId: row.area_id,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at
})

/** The ideas pot (migration 021): per project, newest first. */
export class IdeaRepo {
  constructor(private readonly db: Db) {}

  list(filter: { projectId?: string | null; status?: IdeaStatus | 'all' } = {}): Idea[] {
    const where: string[] = []
    const params: Array<string | null> = []
    const status = filter.status ?? 'open'
    if (status !== 'all') {
      where.push('status = ?')
      params.push(status)
    }
    if (filter.projectId !== undefined) {
      where.push(filter.projectId === null ? 'project_id IS NULL' : 'project_id = ?')
      if (filter.projectId !== null) params.push(filter.projectId)
    }
    const sql = `SELECT * FROM ideas ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC`
    return this.db.all<IdeaRow>(sql, params).map(mapIdea)
  }

  get(id: string): Idea | null {
    const row = this.db.get<IdeaRow>('SELECT * FROM ideas WHERE id = ?', [id])
    return row ? mapIdea(row) : null
  }

  add(input: NewIdea): Idea {
    const text = input.text.trim()
    if (!text) throw new Error('Een idee heeft tekst nodig.')
    const id = newId()
    const now = Date.now()
    this.db.run('INSERT INTO ideas (id, text, project_id, area_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      id,
      text,
      input.projectId ?? null,
      input.areaId ?? null,
      'open',
      now,
      now
    ])
    return this.get(id)!
  }

  update(id: string, patch: Partial<Pick<Idea, 'text' | 'projectId' | 'areaId' | 'status'>>): Idea {
    const current = this.get(id)
    if (!current) throw new Error('Dat idee bestaat niet.')
    const next = { ...current, ...patch }
    this.db.run('UPDATE ideas SET text = ?, project_id = ?, area_id = ?, status = ?, updated_at = ? WHERE id = ?', [
      next.text.trim(),
      next.projectId,
      next.areaId,
      next.status,
      Date.now(),
      id
    ])
    return this.get(id)!
  }

  remove(id: string): void {
    this.db.run('DELETE FROM ideas WHERE id = ?', [id])
  }
}
