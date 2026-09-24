/**
 * Migration 014 against a database that already holds classified appointments.
 *
 * The case that matters is the one the app has been in all along: events carrying
 * `registration_mode` and `counts_as_worked` with no time segment anywhere, because nothing
 * ever wrote one. An empty in-memory database has nothing to back-fill, so it proves nothing.
 */

import { describe, expect, it } from 'vitest'
import { Database } from 'node-sqlite3-wasm'
import { Db, runMigrations } from '../connection.js'
import { MIGRATIONS } from './index.js'

const MINUTE = 60_000
const NINE = Date.parse('2026-08-18T09:00:00')
const TEN = Date.parse('2026-08-18T10:00:00')

/** A database migrated to 13 — everything the calendar needs, and no backfill yet. */
function databaseAt13(): Db {
  const db = new Db(new Database(':memory:'))
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied INTEGER NOT NULL
    )
  `)

  for (const migration of MIGRATIONS.filter((m) => m.id <= 13)) {
    if (migration.sql) db.exec(migration.sql)
    migration.run?.(db)
    db.run('INSERT INTO _migrations (id, name, applied) VALUES (?, ?, ?)', [
      migration.id,
      migration.name,
      Date.now()
    ])
  }
  return db
}

/** An appointment classified as counting toward your hours, the way 013 left it: hourless. */
function seedClassifiedEvent(
  db: Db,
  overrides: {
    id?: string
    areaId?: string | null
    registrationMode?: string
    countsAsWorked?: number
    confirmedMin?: number | null
    cancelled?: number
  } = {}
): string {
  const id = overrides.id ?? 'event-1'
  db.run(
    `INSERT INTO calendar_events
       (id, title, starts_at, ends_at, all_day, event_kind, travel_detached, cancelled,
        attendees, origin, area_id, classification_status, include_in_planning,
        registration_mode, counts_as_worked, confirmed_min, local_updated_at, created_at)
     VALUES (?, ?, ?, ?, 0, 'appointment', 0, ?, '[]', 'outlook', ?, 'confirmed', 1, ?, ?, ?, ?, ?)`,
    [
      id,
      'Projectoverleg Maasarend',
      NINE,
      TEN,
      overrides.cancelled ?? 0,
      overrides.areaId === undefined ? 'stage' : overrides.areaId,
      overrides.registrationMode ?? 'calendar',
      overrides.countsAsWorked ?? 1,
      overrides.confirmedMin ?? null,
      Date.now(),
      Date.now()
    ]
  )
  return id
}

const segments = (db: Db) =>
  db.all<{ id: string; started_at: number; ended_at: number; counts_as_stage_hours: number; area_id: string | null }>(
    'SELECT * FROM time_segments'
  )

describe('backfilling hours that were classified but never counted', () => {
  it('gives a classified appointment the segment it never had', () => {
    const db = databaseAt13()
    seedClassifiedEvent(db)
    expect(segments(db)).toHaveLength(0)

    runMigrations(db)

    const rows = segments(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.started_at).toBe(NINE)
    expect(rows[0]!.ended_at).toBe(TEN)
  })

  it('points the event at what it produced, so nothing is orphaned', () => {
    const db = databaseAt13()
    const id = seedClassifiedEvent(db)

    runMigrations(db)

    const linked = db.get<{ reconciled_segment_id: string | null }>(
      'SELECT reconciled_segment_id FROM calendar_events WHERE id = ?',
      [id]
    )
    expect(linked?.reconciled_segment_id).toBe(segments(db)[0]!.id)
  })

  it('carries the area rule, so internship hours arrive as internship hours', () => {
    const db = databaseAt13()
    seedClassifiedEvent(db, { areaId: 'stage' })
    seedClassifiedEvent(db, { id: 'event-2', areaId: 'personal' })

    runMigrations(db)

    const byArea = new Map(segments(db).map((row) => [row.area_id, row.counts_as_stage_hours]))
    expect(byArea.get('stage')).toBe(1)
    expect(byArea.get('personal')).toBe(0)
  })

  it('honours a confirmed length over the length in the calendar', () => {
    const db = databaseAt13()
    seedClassifiedEvent(db, { registrationMode: 'confirm', confirmedMin: 20 })

    runMigrations(db)

    expect(segments(db)[0]!.ended_at).toBe(NINE + 20 * MINUTE)
  })

  it('leaves alone every event that registers nothing', () => {
    const db = databaseAt13()
    seedClassifiedEvent(db, { id: 'none-mode', registrationMode: 'none' })
    seedClassifiedEvent(db, { id: 'not-worked', countsAsWorked: 0 })
    seedClassifiedEvent(db, { id: 'cancelled', cancelled: 1 })

    runMigrations(db)

    expect(segments(db)).toHaveLength(0)
  })

  it('cannot double-count, however often it runs', () => {
    const db = databaseAt13()
    seedClassifiedEvent(db)

    runMigrations(db)
    // Re-running the migration body directly is the harshest version of the question the
    // `_migrations` table normally answers.
    MIGRATIONS.find((m) => m.id === 14)!.run!(db)

    expect(segments(db)).toHaveLength(1)
  })

  it('closes the run it creates, so no timer looks like it is still going', () => {
    const db = databaseAt13()
    seedClassifiedEvent(db)

    runMigrations(db)

    const open = db.all<{ id: string }>('SELECT id FROM tracking_runs WHERE ended_at IS NULL')
    expect(open).toHaveLength(0)
  })
})
