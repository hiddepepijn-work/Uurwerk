/**
 * Clears the demo data so the app starts on your real hours.
 *
 * The database is copied to a timestamped backup first — this deletes tracking history,
 * and "I did not mean that" has to stay recoverable.
 *
 *   npm run reset            see what would go
 *   npm run reset -- --apply do it
 *   npm run reset -- --apply --all   also remove tasks, projects and planning
 */

import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { openStore } from '../packages/core/src/db/index.js'

const APPLY = process.argv.includes('--apply')
const ALL = process.argv.includes('--all')

const appData = process.env['APPDATA'] ?? join(process.env['USERPROFILE'] ?? '.', 'AppData', 'Roaming')
const dbPath = join(appData, 'uurwerk', 'uurwerk', 'app.db')

if (!existsSync(dbPath)) {
  console.error(`No database at ${dbPath}`)
  process.exit(1)
}

const store = openStore(dbPath)
const count = (table: string): number =>
  store.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0

console.log('Currently stored:')
for (const table of ['time_segments', 'tracking_runs', 'sessions', 'tasks', 'projects', 'planned', 'plan_blocks']) {
  console.log(`   ${table.padEnd(16)} ${count(table)}`)
}

console.log(
  `\nWould remove: all tracking history${ALL ? ', plus tasks, projects and planning' : ' (tasks and projects kept)'}`
)

// No process.exit anywhere below: leaving the process with the WASM database still open
// trips a libuv assertion on the way out.
if (!APPLY) {
  console.log('\nDry run. Pass --apply to go ahead.')
  store.db.close()
} else {
  const backup = `${dbPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  store.db.close()
  copyFileSync(dbPath, backup)
  console.log(`\nBackup written to ${backup}`)

  const db = openStore(dbPath)
  const after = (table: string): number =>
    db.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0

  db.db.transaction(() => {
    // Tracking history always goes — that is the point of the command.
    db.db.run('DELETE FROM time_segments')
    db.db.run('DELETE FROM tracking_runs')
    db.db.run('DELETE FROM sessions')
    db.db.run('DELETE FROM day_reports')

    if (ALL) {
      // Children before parents, even with cascades in place.
      db.db.run('DELETE FROM plan_blocks')
      db.db.run('DELETE FROM plans')
      db.db.run('DELETE FROM planned')
      db.db.run('DELETE FROM task_dependencies')
      db.db.run('DELETE FROM tasks')
      db.db.run('DELETE FROM projects')
      db.db.run('DELETE FROM reports')
    }
  })

  console.log('\nAfter:')
  for (const table of [
    'time_segments',
    'tracking_runs',
    'sessions',
    'tasks',
    'projects',
    'planned',
    'plan_blocks'
  ]) {
    console.log(`   ${table.padEnd(16)} ${after(table)}`)
  }
  db.db.close()
  console.log('\nAreas and settings were left alone.')
}
