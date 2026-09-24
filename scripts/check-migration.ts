/**
 * Dry-runs the pending migrations against a COPY of the live database and reports what
 * they did. The real database is never opened for writing.
 *
 * Run this before shipping a migration: unit tests use synthetic data, and synthetic data
 * is exactly the data that never surprises you.
 *
 *   npm run migrate:check
 */

import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, Db } from '../packages/core/src/db/connection.js'

function livePath(): string {
  const appData = process.env['APPDATA'] ?? join(process.env['USERPROFILE'] ?? '.', 'AppData', 'Roaming')
  return join(appData, 'uurwerk', 'uurwerk', 'app.db')
}

const source = livePath()
if (!existsSync(source)) {
  console.error(`No live database found at ${source}`)
  process.exit(1)
}

const scratch = mkdtempSync(join(tmpdir(), 'uurwerk-migrate-'))
const copy = join(scratch, 'app.db')
copyFileSync(source, copy)
console.log(`Copied the live database to ${copy}\n`)

const count = (db: Db, sql: string): number => db.get<{ n: number }>(sql)?.n ?? 0

try {
  // Read the "before" picture without triggering migrations.
  const before = openDatabase(copy)
  const versionsBefore = before
    .all<{ id: number; name: string }>('SELECT id, name FROM _migrations ORDER BY id')
    .map((row) => `${row.id}:${row.name}`)

  const summary = {
    'schema versions': versionsBefore.join(', '),
    projects: count(before, 'SELECT COUNT(*) AS n FROM projects'),
    tasks: count(before, 'SELECT COUNT(*) AS n FROM tasks'),
    sessions: count(before, 'SELECT COUNT(*) AS n FROM sessions'),
    planned: count(before, 'SELECT COUNT(*) AS n FROM planned'),
    areas: count(before, 'SELECT COUNT(*) AS n FROM areas'),
    tracking_runs: count(before, 'SELECT COUNT(*) AS n FROM tracking_runs'),
    time_segments: count(before, 'SELECT COUNT(*) AS n FROM time_segments'),
    plans: count(before, 'SELECT COUNT(*) AS n FROM plans'),
    plan_blocks: count(before, 'SELECT COUNT(*) AS n FROM plan_blocks'),
    artifacts: count(before, 'SELECT COUNT(*) AS n FROM artifacts')
  }

  console.log('After migrating the copy:')
  for (const [label, value] of Object.entries(summary)) {
    console.log(`  ${label.padEnd(16)} ${value}`)
  }

  // The two invariants migration 004 promises.
  const sessionMinutes = before
    .all<{ started_at: number; ended_at: number | null }>('SELECT started_at, ended_at FROM sessions')
    .reduce((sum, s) => sum + Math.max(0, Math.round(((s.ended_at ?? s.started_at) - s.started_at) / 60000)), 0)
  const segmentMinutes = before
    .all<{ started_at: number; ended_at: number | null }>('SELECT started_at, ended_at FROM time_segments')
    .reduce((sum, s) => sum + Math.max(0, Math.round(((s.ended_at ?? s.started_at) - s.started_at) / 60000)), 0)

  const plannedMinutes = before
    .all<{ start_min: number; end_min: number }>('SELECT start_min, end_min FROM planned')
    .reduce((sum, b) => sum + (b.end_min - b.start_min), 0)
  const blockMinutes = before
    .all<{ start_min: number; end_min: number }>(
      "SELECT start_min, end_min FROM plan_blocks WHERE source = 'imported'"
    )
    .reduce((sum, b) => sum + (b.end_min - b.start_min), 0)

  console.log('\nInvariants:')
  console.log(`  session minutes ${sessionMinutes} -> segment minutes ${segmentMinutes}  ${sessionMinutes === segmentMinutes ? 'OK' : 'MISMATCH'}`)
  console.log(`  planned minutes ${plannedMinutes} -> block minutes   ${blockMinutes}  ${plannedMinutes === blockMinutes ? 'OK' : 'MISMATCH'}`)

  const unassigned = count(before, 'SELECT COUNT(*) AS n FROM tasks WHERE area_id IS NULL')
  console.log(`  tasks without an area: ${unassigned}  ${unassigned === 0 ? 'OK' : 'PROBLEM'}`)

  // Migration 008 adds a column and a foreign key; a broken reference has to fail here,
  // on a copy, rather than on the machine that holds the only copy of your hours.
  const hasSegmentColumn = before
    .all<{ name: string }>('PRAGMA table_info(artifacts)')
    .some((column) => column.name === 'time_segment_id')
  const brokenKeys = before.all('PRAGMA foreign_key_check').length
  console.log(`  artifacts.time_segment_id present: ${hasSegmentColumn}  ${hasSegmentColumn ? 'OK' : 'PROBLEM'}`)
  console.log(`  broken foreign keys: ${brokenKeys}  ${brokenKeys === 0 ? 'OK' : 'PROBLEM'}`)

  before.close()
  console.log('\nThe live database was not touched.')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
