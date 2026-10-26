import type { PrepCheck, PrepStatus } from '../../contract/types.js'
import type { Db } from '../connection.js'

interface PrepRow {
  ref: string
  status: PrepStatus
  note: string | null
  updated_at: number
}

const mapCheck = (row: PrepRow): PrepCheck => ({
  ref: row.ref,
  status: row.status,
  note: row.note,
  updatedAt: row.updated_at
})

/** Per task ("t:<id>") or appointment ("a:<id>"): has preparation been checked (migration 023). */
export class PrepCheckRepo {
  constructor(private readonly db: Db) {}

  get(ref: string): PrepCheck | null {
    const row = this.db.get<PrepRow>('SELECT * FROM prep_checks WHERE ref = ?', [ref])
    return row ? mapCheck(row) : null
  }

  all(): Map<string, PrepCheck> {
    return new Map(this.db.all<PrepRow>('SELECT * FROM prep_checks').map((row) => [row.ref, mapCheck(row)]))
  }

  set(ref: string, status: PrepStatus, note: string | null = null): PrepCheck {
    this.db.run(
      `INSERT INTO prep_checks (ref, status, note, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(ref) DO UPDATE SET status = excluded.status, note = excluded.note, updated_at = excluded.updated_at`,
      [ref, status, note?.trim() || null, Date.now()]
    )
    return this.get(ref)!
  }
}
