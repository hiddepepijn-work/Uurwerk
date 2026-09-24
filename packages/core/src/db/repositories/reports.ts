import type { IsoWeek } from '../../contract/types.js'
import { Db } from '../connection.js'

export interface ReportRecord {
  week: IsoWeek
  generatedAt: number | null
  docxPath: string | null
  summary: string
  sentAt: number | null
}

interface ReportRow {
  week: string
  generated_at: number | null
  docx_path: string | null
  summary: string
  sent_at: number | null
}

const map = (row: ReportRow): ReportRecord => ({
  week: row.week,
  generatedAt: row.generated_at,
  docxPath: row.docx_path,
  summary: row.summary,
  sentAt: row.sent_at
})

export class ReportRepo {
  constructor(private readonly db: Db) {}

  get(week: IsoWeek): ReportRecord | null {
    const row = this.db.get<ReportRow>('SELECT * FROM reports WHERE week = ?', [week])
    return row ? map(row) : null
  }

  /** Creates the row on first touch so the summary box always has somewhere to save to. */
  ensure(week: IsoWeek): ReportRecord {
    const existing = this.get(week)
    if (existing) return existing
    this.db.run('INSERT INTO reports (week, summary) VALUES (?, ?)', [week, ''])
    return this.get(week)!
  }

  saveSummary(week: IsoWeek, summary: string): void {
    this.ensure(week)
    this.db.run('UPDATE reports SET summary = ? WHERE week = ?', [summary.slice(0, 1000), week])
  }

  markGenerated(week: IsoWeek, docxPath: string): void {
    this.ensure(week)
    this.db.run('UPDATE reports SET generated_at = ?, docx_path = ? WHERE week = ?', [
      Date.now(),
      docxPath,
      week
    ])
  }

  markSent(week: IsoWeek): void {
    this.ensure(week)
    this.db.run('UPDATE reports SET sent_at = ? WHERE week = ?', [Date.now(), week])
  }

}
