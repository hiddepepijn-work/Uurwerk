/**
 * Migration 003 + 004 against a database that already holds pre-planner data.
 *
 * The in-memory tests elsewhere start from an empty database, where the backfill has
 * nothing to do. These tests build a version-2 database, fill it the way the live one is
 * filled, and only then migrate — which is the case that can actually lose data.
 */

import { describe, expect, it } from 'vitest'
import { Database } from 'node-sqlite3-wasm'
import { Db, runMigrations } from '../connection.js'
import { MIGRATIONS } from './index.js'
import { minutesBetween, toIsoWeek, fromIsoDate } from '../../util/time.js'

const MINUTE = 60_000

/** A database at schema version 2, with migrations 1 and 2 recorded as applied. */
function legacyDatabase(): Db {
  const db = new Db(new Database(':memory:'))
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied INTEGER NOT NULL
    )
  `)

  for (const migration of MIGRATIONS.filter((m) => m.id <= 2)) {
    if (migration.sql) db.exec(migration.sql)
    db.run('INSERT INTO _migrations (id, name, applied) VALUES (?, ?, ?)', [
      migration.id,
      migration.name,
      Date.now()
    ])
  }
  return db
}

/** Fills it the way the real database is filled before the planner existed. */
function seedLegacyData(db: Db): { sessionMinutes: number; plannedMinutes: number; date: string } {
  db.run("INSERT INTO projects (id, name, color, shareable, archived) VALUES ('p1', 'SDSS', '#1B3A5C', 1, 0)")
  db.run("INSERT INTO projects (id, name, color, shareable, archived) VALUES ('p2', 'General', '#4A3A1C', 0, 0)")

  const now = Date.now()
  for (const [id, project] of [
    ['t1', 'p1'],
    ['t2', 'p2'],
    ['t3', null]
  ] as const) {
    db.run(
      `INSERT INTO tasks (id, project_id, title, priority, status, sort_order, created_at)
       VALUES (?, ?, ?, 'medium', 'open', 0, ?)`,
      [id, project, `Task ${id}`, now]
    )
  }

  // Three closed sessions, one still running, and one with no task at all.
  const sessions: Array<[string, string | null, number, number | null]> = [
    ['s1', 't1', now - 300 * MINUTE, now - 240 * MINUTE],
    ['s2', 't2', now - 200 * MINUTE, now - 150 * MINUTE],
    ['s3', 't1', now - 120 * MINUTE, now - 95 * MINUTE],
    ['s4', null, now - 90 * MINUTE, now - 80 * MINUTE],
    ['s5', 't3', now - 30 * MINUTE, null]
  ]
  for (const [id, task, started, ended] of sessions) {
    db.run('INSERT INTO sessions (id, task_id, started_at, ended_at) VALUES (?, ?, ?, ?)', [
      id,
      task,
      started,
      ended
    ])
  }

  const date = '2026-08-03'
  const planned: Array<[string, string, string, number, number]> = [
    ['b1', 't1', date, 540, 720],
    ['b2', 't2', date, 780, 900],
    ['b3', 't1', '2026-08-11', 540, 660] // a different ISO week
  ]
  for (const [id, task, day, start, end] of planned) {
    db.run('INSERT INTO planned (id, task_id, date, start_min, end_min) VALUES (?, ?, ?, ?, ?)', [
      id,
      task,
      day,
      start,
      end
    ])
  }

  return {
    sessionMinutes: sessions.reduce(
      (sum, [, , started, ended]) => sum + minutesBetween(started, ended ?? started),
      0
    ),
    plannedMinutes: planned.reduce((sum, [, , , start, end]) => sum + (end - start), 0),
    date
  }
}

describe('migration 004 backfill', () => {
  it('creates the system areas with fixed ids', () => {
    const db = legacyDatabase()
    seedLegacyData(db)
    runMigrations(db)

    const areas = db.all<{
      id: string
      counts_as_stage_hours: number
      default_share_supervisor: number
      default_share_teacher: number
    }>(
      `SELECT id, counts_as_stage_hours, default_share_supervisor, default_share_teacher
       FROM areas ORDER BY sort_order`
    )
    // Migration 004 seeds the first three; 009 adds School alongside them.
    expect(areas.map((a) => a.id)).toEqual(['stage', 'work', 'personal', 'school'])

    // Stage counts and may share; Work and Personal do neither.
    expect(areas[0]!.counts_as_stage_hours).toBe(1)
    expect(areas[0]!.default_share_supervisor).toBe(1)
    expect(areas[1]!.counts_as_stage_hours).toBe(0)
    expect(areas[1]!.default_share_supervisor).toBe(0)
    expect(areas[2]!.default_share_supervisor).toBe(0)

    // School is the one area the two audiences disagree about: the teacher sees it, the
    // internship supervisor does not, and it never counts toward internship hours.
    expect(areas[3]!.counts_as_stage_hours).toBe(0)
    expect(areas[3]!.default_share_supervisor).toBe(0)
    expect(areas[3]!.default_share_teacher).toBe(1)
  })

  it('leaves existing tasks in Stage rather than reclassifying them', () => {
    const db = legacyDatabase()
    seedLegacyData(db)
    runMigrations(db)

    // Adding Work, School and organizations must not move a single historical task: the
    // hours were internship hours when they were logged, and they stay that way until the
    // user says otherwise.
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE area_id <> 'stage'")?.n).toBe(0)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM projects WHERE organization_id IS NOT NULL')?.n).toBe(0)
  })

  it('assigns every existing task and project to Stage', () => {
    const db = legacyDatabase()
    seedLegacyData(db)
    runMigrations(db)

    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE area_id <> 'stage'")?.n).toBe(0)
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM projects WHERE area_id <> 'stage'")?.n).toBe(0)
  })

  it('turns every session into a run with one segment, preserving total minutes', () => {
    const db = legacyDatabase()
    const { sessionMinutes } = seedLegacyData(db)
    runMigrations(db)

    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tracking_runs')?.n).toBe(5)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM time_segments')?.n).toBe(5)

    const migrated = db
      .all<{ started_at: number; ended_at: number | null }>(
        'SELECT started_at, ended_at FROM time_segments'
      )
      .reduce((sum, s) => sum + minutesBetween(s.started_at, s.ended_at ?? s.started_at), 0)
    expect(migrated).toBe(sessionMinutes)
  })

  it('imports sessions without a task as Stage, so historical totals do not drop', () => {
    const db = legacyDatabase()
    seedLegacyData(db)
    runMigrations(db)

    const orphan = db.get<{ area_id: string; counts_as_stage_hours: number }>(
      'SELECT area_id, counts_as_stage_hours FROM time_segments WHERE task_id IS NULL'
    )
    expect(orphan?.area_id).toBe('stage')
    expect(orphan?.counts_as_stage_hours).toBe(1)
  })

  it('keeps the running session open rather than closing it', () => {
    const db = legacyDatabase()
    seedLegacyData(db)
    runMigrations(db)

    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM time_segments WHERE ended_at IS NULL')?.n).toBe(1)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tracking_runs WHERE ended_at IS NULL')?.n).toBe(1)
  })

  it('stamps every migrated segment as Stage hours', () => {
    const db = legacyDatabase()
    seedLegacyData(db)
    runMigrations(db)

    expect(
      db.get<{ n: number }>('SELECT COUNT(*) AS n FROM time_segments WHERE counts_as_stage_hours <> 1')?.n
    ).toBe(0)
  })

  it('imports planned rows as one accepted week plan per ISO week', () => {
    const db = legacyDatabase()
    const { plannedMinutes, date } = seedLegacyData(db)
    runMigrations(db)

    const plans = db.all<{ period_key: string; status: string; version: number; parent_plan_id: string | null }>(
      'SELECT period_key, status, version, parent_plan_id FROM plans ORDER BY period_key'
    )
    // Two distinct ISO weeks in the seed data.
    expect(plans).toHaveLength(2)
    expect(plans.every((p) => p.status === 'accepted')).toBe(true)
    expect(plans.every((p) => p.version === 1)).toBe(true)
    expect(plans.every((p) => p.parent_plan_id === null)).toBe(true)
    expect(plans.map((p) => p.period_key)).toContain(toIsoWeek(fromIsoDate(date)))

    const blocks = db.all<{ start_min: number; end_min: number; source: string }>(
      'SELECT start_min, end_min, source FROM plan_blocks'
    )
    expect(blocks).toHaveLength(3)
    expect(blocks.every((b) => b.source === 'imported')).toBe(true)
    expect(blocks.reduce((sum, b) => sum + (b.end_min - b.start_min), 0)).toBe(plannedMinutes)
  })

  it('leaves the original sessions and planned rows in place', () => {
    const db = legacyDatabase()
    seedLegacyData(db)
    runMigrations(db)

    // Nothing is deleted until the planner has proven itself; a later migration drops these.
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions')?.n).toBe(5)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM planned')?.n).toBe(3)
  })

  it('is idempotent — running the migrations again changes nothing', () => {
    const db = legacyDatabase()
    seedLegacyData(db)
    runMigrations(db)
    runMigrations(db)

    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM time_segments')?.n).toBe(5)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM plan_blocks')?.n).toBe(3)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM areas')?.n).toBe(4)
    // The seeded organizations and work types are inserted the same way — once.
    // Maasarend and the school come from 009, Jumbo from 012.
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM organizations')?.n).toBe(3)
    // Seven from 010, plus Travel from 013 — inserted once however often migrations rerun.
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM work_types')?.n).toBe(8)
  })

  it('records both migrations as applied', () => {
    const db = legacyDatabase()
    seedLegacyData(db)
    runMigrations(db)

    const applied = db.all<{ id: number }>('SELECT id FROM _migrations ORDER BY id').map((r) => r.id)
    expect(applied).toEqual(MIGRATIONS.map((migration) => migration.id))
  })
})
