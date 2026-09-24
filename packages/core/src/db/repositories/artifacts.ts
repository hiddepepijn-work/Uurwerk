import type { Artifact, ArtifactKind, IsoDate } from '../../contract/types.js'
import { Db, fromDbBool, newId, toDbBool } from '../connection.js'

interface ArtifactRow {
  id: string
  session_id: string | null
  time_segment_id: string | null
  day: string
  kind: ArtifactKind
  path: string
  captured_at: number
  included: number
  /** Only present on the joined queries; the plain SELECT * leaves it undefined. */
  task_title?: string | null
}

const map = (row: ArtifactRow): Artifact => ({
  id: row.id,
  sessionId: row.session_id,
  timeSegmentId: row.time_segment_id,
  day: row.day,
  kind: row.kind,
  path: row.path,
  capturedAt: row.captured_at,
  included: fromDbBool(row.included),
  taskTitle: row.task_title ?? null
})

/**
 * Frames come back with the task that was running when they were taken.
 *
 * Doing it in the query rather than in the caller keeps the approval grid honest: reviewing
 * a screenshot without knowing which task it belongs to is guesswork, and guesswork is a
 * poor basis for deciding what your supervisor gets to see.
 */
const SELECT_WITH_TASK = /* sql */ `
  SELECT a.*, t.title AS task_title
  FROM artifacts a
  LEFT JOIN time_segments s ON s.id = a.time_segment_id
  LEFT JOIN tasks t         ON t.id = s.task_id
`

export class ArtifactRepo {
  constructor(private readonly db: Db) {}

  get(id: string): Artifact | null {
    const row = this.db.get<ArtifactRow>(`${SELECT_WITH_TASK} WHERE a.id = ?`, [id])
    return row ? map(row) : null
  }

  add(input: {
    sessionId?: string | null
    timeSegmentId?: string | null
    day: IsoDate
    kind: ArtifactKind
    path: string
    capturedAt?: number
    /**
     * Automatic screenshots land with included = false on purpose.
     * Nothing reaches a report until it is approved in the end-of-day wizard.
     */
    included?: boolean
  }): Artifact {
    const id = newId()
    this.db.run(
      `INSERT INTO artifacts (id, session_id, time_segment_id, day, kind, path, captured_at, included)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.sessionId ?? null,
        input.timeSegmentId ?? null,
        input.day,
        input.kind,
        input.path,
        input.capturedAt ?? Date.now(),
        toDbBool(input.included ?? false)
      ]
    )
    return this.get(id)!
  }

  listBetween(from: IsoDate, to: IsoDate, kind?: ArtifactKind): Artifact[] {
    const sql = kind
      ? `${SELECT_WITH_TASK} WHERE a.day BETWEEN ? AND ? AND a.kind = ? ORDER BY a.captured_at`
      : `${SELECT_WITH_TASK} WHERE a.day BETWEEN ? AND ? ORDER BY a.captured_at`
    const params = kind ? [from, to, kind] : [from, to]
    return this.db.all<ArtifactRow>(sql, params).map(map)
  }

  listByDay(day: IsoDate, kind?: ArtifactKind): Artifact[] {
    return this.listBetween(day, day, kind)
  }

  setIncluded(id: string, included: boolean): void {
    this.db.run('UPDATE artifacts SET included = ? WHERE id = ?', [toDbBool(included), id])
  }

  /** Bulk approval for a whole day — reviewing 90 frames one click at a time is not review. */
  setIncludedForDay(day: IsoDate, kind: ArtifactKind, included: boolean): number {
    const rows = this.db.all<{ id: string }>(
      'SELECT id FROM artifacts WHERE day = ? AND kind = ?',
      [day, kind]
    )
    this.db.transaction(() => {
      this.db.run('UPDATE artifacts SET included = ? WHERE day = ? AND kind = ?', [
        toDbBool(included),
        day,
        kind
      ])
    })
    return rows.length
  }

  remove(id: string): void {
    this.db.run('DELETE FROM artifacts WHERE id = ?', [id])
  }

  /** Screenshot rows older than the cutoff — the retention job deletes the files too. */
  screenshotsOlderThan(cutoffDay: IsoDate): Artifact[] {
    return this.db
      .all<ArtifactRow>(
        `${SELECT_WITH_TASK} WHERE a.kind = 'screenshot' AND a.day < ? ORDER BY a.day`,
        [cutoffDay]
      )
      .map(map)
  }
}
