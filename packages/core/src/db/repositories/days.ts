import type { DayReport, IsoDate, PublishAudience, PublishFlags } from '../../contract/types.js'
import { NO_PUBLISH } from '../../contract/types.js'
import { Db } from '../connection.js'

interface DayRow {
  date: string
  summary: string
  publish_flags: string
  reviewed_at: number | null
  published_at: number | null
}

/** Unknown or corrupt flags collapse to "publish nothing" — never to "publish everything". */
function parseFlags(json: string): PublishFlags {
  try {
    return { ...NO_PUBLISH, ...(JSON.parse(json) as Partial<PublishFlags>) }
  } catch {
    return { ...NO_PUBLISH }
  }
}

const map = (row: DayRow): DayReport => ({
  date: row.date,
  summary: row.summary,
  flags: parseFlags(row.publish_flags),
  reviewedAt: row.reviewed_at,
  publishedAt: row.published_at
})

export class DayRepo {
  constructor(private readonly db: Db) {}

  get(date: IsoDate): DayReport | null {
    const row = this.db.get<DayRow>('SELECT * FROM day_reports WHERE date = ?', [date])
    return row ? map(row) : null
  }

  ensure(date: IsoDate): DayReport {
    const existing = this.get(date)
    if (existing) return existing
    this.db.run('INSERT INTO day_reports (date) VALUES (?)', [date])
    return this.get(date)!
  }

  saveSummary(date: IsoDate, summary: string): DayReport {
    this.ensure(date)
    this.db.run('UPDATE day_reports SET summary = ?, reviewed_at = ? WHERE date = ?', [
      summary.slice(0, 1000),
      Date.now(),
      date
    ])
    return this.get(date)!
  }

  saveFlags(date: IsoDate, flags: PublishFlags): DayReport {
    this.ensure(date)
    this.db.run('UPDATE day_reports SET publish_flags = ? WHERE date = ?', [
      JSON.stringify(flags),
      date
    ])
    return this.get(date)!
  }

  /** The consent stamp. Set only by an explicit Publish action in the wizard. */
  markPublished(date: IsoDate): DayReport {
    this.ensure(date)
    this.db.run('UPDATE day_reports SET published_at = ? WHERE date = ?', [Date.now(), date])
    return this.get(date)!
  }

  /** Revoking consent. The caller must delete the remote files before calling this. */
  clearPublished(date: IsoDate): DayReport {
    this.ensure(date)
    this.db.run('UPDATE day_reports SET published_at = NULL WHERE date = ?', [date])
    return this.get(date)!
  }

  listPublishedBetween(from: IsoDate, to: IsoDate): DayReport[] {
    return this.db
      .all<DayRow>(
        'SELECT * FROM day_reports WHERE date BETWEEN ? AND ? AND published_at IS NOT NULL ORDER BY date',
        [from, to]
      )
      .map(map)
  }

}

// -------------------------------------------------------------- remote files

export interface PublishedFile {
  id: string
  artifactId: string | null
  day: IsoDate
  remoteName: string
  /** The audience a JSON payload was written for; null for an image, which both may see. */
  audience: PublishAudience | null
  publishedAt: number
}

interface PublishedRow {
  id: string
  artifact_id: string | null
  day: string
  remote_name: string
  audience: PublishAudience | null
  published_at: number
}

const mapPublished = (row: PublishedRow): PublishedFile => ({
  id: row.id,
  artifactId: row.artifact_id,
  day: row.day,
  remoteName: row.remote_name,
  audience: row.audience,
  publishedAt: row.published_at
})

/**
 * The ledger of what actually left this machine.
 *
 * Without this, "unpublish" is guesswork. With it, revoking a day is exact: every remote
 * name that was ever uploaded for that day is listed here and can be deleted.
 */
export class PublishedFileRepo {
  constructor(private readonly db: Db) {}

  record(file: Omit<PublishedFile, 'publishedAt'>): void {
    this.db.run(
      `INSERT INTO published_files (id, artifact_id, day, remote_name, audience, published_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [file.id, file.artifactId, file.day, file.remoteName, file.audience, Date.now()]
    )
  }

  listByDay(day: IsoDate): PublishedFile[] {
    return this.db
      .all<PublishedRow>('SELECT * FROM published_files WHERE day = ?', [day])
      .map(mapPublished)
  }

  forget(day: IsoDate): void {
    this.db.run('DELETE FROM published_files WHERE day = ?', [day])
  }
}
