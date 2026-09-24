/**
 * Removes mis-click segments from the log.
 *
 * Clicking through a few tasks used to leave a zero-minute segment behind for each one,
 * which cluttered the timeline and made "sessions today" meaningless. Switching now
 * discards them as they happen; this cleans up what was recorded before that fix.
 *
 * Dry run by default — nothing is deleted until you pass --apply.
 *
 *   npm run tidy            see what would go
 *   npm run tidy -- --apply actually remove it
 */

import { join } from 'node:path'
import { openStore } from '../packages/core/src/db/index.js'

const APPLY = process.argv.includes('--apply')
/** Anything shorter than this was not work. Matches MIN_SEGMENT_MS in the tracking service. */
const MIN_MS = 20_000

const appData = process.env['APPDATA'] ?? join(process.env['USERPROFILE'] ?? '.', 'AppData', 'Roaming')
const store = openStore(join(appData, 'uurwerk', 'uurwerk', 'app.db'))

interface Row {
  id: string
  tracking_run_id: string
  started_at: number
  ended_at: number | null
  title: string | null
}

const trivial = store.db.all<Row>(
  `SELECT g.id, g.tracking_run_id, g.started_at, g.ended_at, t.title
   FROM time_segments g
   LEFT JOIN tasks t ON t.id = g.task_id
   WHERE g.ended_at IS NOT NULL AND (g.ended_at - g.started_at) < ?
   ORDER BY g.started_at`,
  [MIN_MS]
)

console.log(`Segments shorter than ${MIN_MS / 1000}s: ${trivial.length}`)
for (const row of trivial.slice(0, 12)) {
  const seconds = Math.round(((row.ended_at ?? row.started_at) - row.started_at) / 1000)
  console.log(`   ${new Date(row.started_at).toLocaleTimeString()}  ${seconds}s  ${row.title ?? 'Untracked'}`)
}
if (trivial.length > 12) console.log(`   … and ${trivial.length - 12} more`)

if (!APPLY) {
  console.log('\nDry run. Pass --apply to remove them.')
  store.db.close()
  process.exit(0)
}

store.db.transaction(() => {
  for (const row of trivial) store.tracking.removeSegment(row.id)

  // A run whose every segment was a mis-click has nothing left to describe.
  const empty = store.db.all<{ id: string }>(
    `SELECT r.id FROM tracking_runs r
     WHERE NOT EXISTS (SELECT 1 FROM time_segments g WHERE g.tracking_run_id = r.id)`
  )
  for (const run of empty) store.db.run('DELETE FROM tracking_runs WHERE id = ?', [run.id])
  console.log(`\nRemoved ${trivial.length} segment(s) and ${empty.length} empty run(s).`)
})

store.db.close()
