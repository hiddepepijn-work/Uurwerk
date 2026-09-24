import type {
  FixedEvent,
  FixedEventKind,
  IsoDate,
  NewRecurringCommitment,
  RecurringCommitment
} from '../../contract/types.js'
import { Db, fromDbBool, newId, toDbBool } from '../connection.js'
import { fromIsoDate, toIsoDate } from '../../util/time.js'

interface CommitmentRow {
  id: string
  title: string
  weekday: number
  start_min: number
  end_min: number
  kind: FixedEventKind
  area_id: string | null
  organization_id: string | null
  active_from: string
  active_to: string | null
  archived: number
}

const map = (row: CommitmentRow): RecurringCommitment => ({
  id: row.id,
  title: row.title,
  weekday: row.weekday,
  startMin: row.start_min,
  endMin: row.end_min,
  kind: row.kind,
  areaId: row.area_id,
  organizationId: row.organization_id,
  activeFrom: row.active_from,
  activeTo: row.active_to,
  archived: fromDbBool(row.archived)
})

/**
 * Standing weekly commitments, and their expansion into actual days.
 *
 * The planner only ever asks "what is in the way on this date", so the expansion happens
 * here and hands back the same `FixedEvent` shape a one-off meeting has. Nothing downstream
 * needs to know whether a wall came from a rule or from a single entry.
 */
export class CommitmentRepo {
  constructor(private readonly db: Db) {}

  list(includeArchived = false): RecurringCommitment[] {
    const sql = includeArchived
      ? 'SELECT * FROM recurring_commitments ORDER BY weekday, start_min'
      : 'SELECT * FROM recurring_commitments WHERE archived = 0 ORDER BY weekday, start_min'
    return this.db.all<CommitmentRow>(sql).map(map)
  }

  get(id: string): RecurringCommitment | null {
    const row = this.db.get<CommitmentRow>('SELECT * FROM recurring_commitments WHERE id = ?', [id])
    return row ? map(row) : null
  }

  create(input: NewRecurringCommitment): RecurringCommitment {
    if (input.endMin <= input.startMin) {
      throw new Error('A commitment has to end after it starts.')
    }

    const id = newId()
    this.db.run(
      `INSERT INTO recurring_commitments
         (id, title, weekday, start_min, end_min, kind, area_id, organization_id,
          active_from, active_to, archived, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        id,
        input.title.trim(),
        input.weekday,
        input.startMin,
        input.endMin,
        input.kind ?? 'unavailable',
        input.areaId ?? null,
        input.organizationId ?? null,
        input.activeFrom ?? toIsoDate(Date.now()),
        input.activeTo ?? null,
        Date.now()
      ]
    )
    return this.get(id)!
  }

  update(id: string, patch: Partial<RecurringCommitment>): RecurringCommitment {
    const current = this.get(id)
    if (!current) throw new Error(`Commitment not found: ${id}`)

    const next = { ...current, ...patch, id }
    if (next.endMin <= next.startMin) {
      throw new Error('A commitment has to end after it starts.')
    }

    this.db.run(
      `UPDATE recurring_commitments SET
         title = ?, weekday = ?, start_min = ?, end_min = ?, kind = ?, area_id = ?,
         organization_id = ?, active_from = ?, active_to = ?, archived = ?
       WHERE id = ?`,
      [
        next.title.trim(),
        next.weekday,
        next.startMin,
        next.endMin,
        next.kind,
        next.areaId,
        next.organizationId,
        next.activeFrom,
        next.activeTo,
        toDbBool(next.archived),
        id
      ]
    )
    return this.get(id)!
  }

  /**
   * Ends a commitment without deleting it.
   *
   * Deleting would rewrite history: last month's plans were built around those hours, and a
   * shift you no longer work is not a shift you never worked.
   */
  end(id: string, lastDay: IsoDate): RecurringCommitment {
    return this.update(id, { activeTo: lastDay })
  }

  archive(id: string): void {
    this.db.run('UPDATE recurring_commitments SET archived = 1 WHERE id = ?', [id])
  }

  /**
   * The occurrences that fall on one date, as ordinary fixed events.
   *
   * Ids are derived from the rule and the date so the same occurrence is stable across
   * calls — the planner keeps blocks by id, and a wall that changes identity every refresh
   * would move the plan underneath itself.
   */
  occurrencesOn(date: IsoDate): FixedEvent[] {
    const weekday = ((fromIsoDate(date).getDay() + 6) % 7) + 1

    return this.db
      .all<CommitmentRow>(
        `SELECT * FROM recurring_commitments
         WHERE archived = 0
           AND weekday = ?
           AND active_from <= ?
           AND (active_to IS NULL OR active_to >= ?)
         ORDER BY start_min`,
        [weekday, date, date]
      )
      .map((row) => ({
        id: `commitment:${row.id}:${date}`,
        date,
        startMin: row.start_min,
        endMin: row.end_min,
        title: row.title,
        kind: row.kind,
        areaId: row.area_id,
        recurring: true
      }))
  }
}
