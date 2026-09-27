import type { IsoDate, JarvisDayLog, JarvisProposal, NewRule, Rule } from '../../contract/types.js'
import { Db, fromDbBool, newId, toDbBool } from '../connection.js'

interface RuleRow {
  id: string
  kind: 'hard' | 'soft'
  type: string
  config: string
  description: string
  active: number
  created_at: number
  updated_at: number
}

interface DayLogRow {
  date: string
  opening_done_at: number | null
  closing_done_at: number | null
  summary: string | null
}

interface ProposalRow {
  id: string
  tool: string
  payload: string
  summary: string
  status: JarvisProposal['status']
  result: string | null
  error: string | null
  created_at: number
  expires_at: number
}

const parse = <T>(text: string | null, fallback: T): T => {
  if (text === null) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

const mapRule = (row: RuleRow): Rule => ({
  id: row.id,
  kind: row.kind,
  type: row.type,
  config: parse(row.config, {}),
  description: row.description,
  active: fromDbBool(row.active),
  createdAt: row.created_at,
  updatedAt: row.updated_at
})

const mapProposal = (row: ProposalRow): JarvisProposal => ({
  id: row.id,
  tool: row.tool,
  payload: parse(row.payload, {}),
  summary: row.summary,
  status: row.status,
  result: parse(row.result, null),
  error: row.error,
  createdAt: row.created_at,
  expiresAt: row.expires_at
})

/** Standing wishes: hard ones for the planner, soft ones for Jarvis's context. */
export class RuleRepo {
  constructor(private readonly db: Db) {}

  list(includeInactive = false): Rule[] {
    const sql = includeInactive
      ? 'SELECT * FROM rules ORDER BY kind, created_at'
      : 'SELECT * FROM rules WHERE active = 1 ORDER BY kind, created_at'
    return this.db.all<RuleRow>(sql).map(mapRule)
  }

  get(id: string): Rule | null {
    const row = this.db.get<RuleRow>('SELECT * FROM rules WHERE id = ?', [id])
    return row ? mapRule(row) : null
  }

  add(input: NewRule): Rule {
    if (!input.description.trim()) throw new Error('A rule needs a description.')
    const id = newId()
    const now = Date.now()
    this.db.run(
      `INSERT INTO rules (id, kind, type, config, description, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.kind,
        input.type,
        JSON.stringify(input.config ?? {}),
        input.description.trim(),
        toDbBool(input.active ?? true),
        now,
        now
      ]
    )
    return this.get(id)!
  }

  update(id: string, patch: Partial<Omit<Rule, 'id' | 'createdAt' | 'updatedAt'>>): Rule {
    const current = this.get(id)
    if (!current) throw new Error(`No rule ${id}.`)
    const next = { ...current, ...patch }
    this.db.run(
      `UPDATE rules SET kind = ?, type = ?, config = ?, description = ?, active = ?, updated_at = ? WHERE id = ?`,
      [next.kind, next.type, JSON.stringify(next.config), next.description, toDbBool(next.active), Date.now(), id]
    )
    return this.get(id)!
  }
}

/** Per day: did the opening and the closing happen, and the summary to start from. */
export class DayLogRepo {
  constructor(private readonly db: Db) {}

  get(date: IsoDate): JarvisDayLog {
    const row = this.db.get<DayLogRow>('SELECT * FROM jarvis_day_log WHERE date = ?', [date])
    return {
      date,
      openingDoneAt: row?.opening_done_at ?? null,
      closingDoneAt: row?.closing_done_at ?? null,
      summary: row?.summary ?? null
    }
  }

  mark(date: IsoDate, patch: { opening?: boolean; closing?: boolean; summary?: string | null }): JarvisDayLog {
    const current = this.get(date)
    const now = Date.now()
    this.db.run(
      `INSERT INTO jarvis_day_log (date, opening_done_at, closing_done_at, summary) VALUES (?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         opening_done_at = excluded.opening_done_at,
         closing_done_at = excluded.closing_done_at,
         summary = excluded.summary`,
      [
        date,
        patch.opening ? (current.openingDoneAt ?? now) : current.openingDoneAt,
        patch.closing ? (current.closingDoneAt ?? now) : current.closingDoneAt,
        patch.summary !== undefined ? patch.summary : current.summary
      ]
    )
    return this.get(date)
  }

  /** The most recent day with a summary before `date`: what a new conversation starts from. */
  lastSummaryBefore(date: IsoDate): JarvisDayLog | null {
    const row = this.db.get<DayLogRow>(
      'SELECT * FROM jarvis_day_log WHERE date < ? AND summary IS NOT NULL ORDER BY date DESC LIMIT 1',
      [date]
    )
    return row ? this.get(row.date) : null
  }
}

/** What Jarvis proposed and what came of it. Local to this copy; never synced. */
export class ProposalRepo {
  constructor(private readonly db: Db) {}

  create(input: Pick<JarvisProposal, 'tool' | 'payload' | 'summary' | 'expiresAt'>): JarvisProposal {
    const id = `v${newId().replace(/-/g, '').slice(0, 8)}`
    this.db.run(
      `INSERT INTO _jarvis_proposals (id, tool, payload, summary, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      [id, input.tool, JSON.stringify(input.payload), input.summary, Date.now(), input.expiresAt]
    )
    return this.get(id)!
  }

  get(id: string): JarvisProposal | null {
    const row = this.db.get<ProposalRow>('SELECT * FROM _jarvis_proposals WHERE id = ?', [id])
    return row ? mapProposal(row) : null
  }

  pending(): JarvisProposal[] {
    return this.db
      .all<ProposalRow>(`SELECT * FROM _jarvis_proposals WHERE status = 'pending' ORDER BY created_at`)
      .map(mapProposal)
  }

  settle(id: string, patch: { status: JarvisProposal['status']; result?: unknown; error?: string | null }): JarvisProposal {
    this.db.run('UPDATE _jarvis_proposals SET status = ?, result = ?, error = ? WHERE id = ?', [
      patch.status,
      patch.result === undefined ? null : JSON.stringify(patch.result),
      patch.error ?? null,
      id
    ])
    const settled = this.get(id)
    if (!settled) throw new Error(`No proposal ${id}.`)
    return settled
  }

  /** Old proposals go: a week is plenty to look back at what a "ja" did. */
  prune(olderThanMs: number): void {
    this.db.run('DELETE FROM _jarvis_proposals WHERE created_at < ?', [Date.now() - olderThanMs])
  }
}
