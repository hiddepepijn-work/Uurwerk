/**
 * Prints what Today would show, straight from the live database.
 *
 * Debug helper: when a screen looks empty, this answers "is the data missing or is the
 * screen not reading it?" without guessing.
 *
 *   npx tsx scripts/inspect-today.ts
 */

import { join } from 'node:path'
import { openStore } from '../packages/core/src/db/index.js'
import { toIsoDate, toIsoWeek, weekRange, dayRange } from '../packages/core/src/util/time.js'
import { StatsService } from '../packages/core/src/services/stats.js'

const appData = process.env['APPDATA'] ?? join(process.env['USERPROFILE'] ?? '.', 'AppData', 'Roaming')
const store = openStore(join(appData, 'uurwerk', 'uurwerk', 'app.db'))

const today = toIsoDate(Date.now())
const week = toIsoWeek(Date.now())
const { from, to } = weekRange(week)
const { startMs, endMs } = dayRange(today)

console.log(`today ${today}   week ${week} (${from} .. ${to})\n`)

// What the Today agenda currently reads: the legacy `planned` table.
const legacy = store.planning.listBetween(from, to)
console.log(`legacy "planned" rows this week: ${legacy.length}`)
for (const block of legacy.filter((b) => b.date === today)) {
  console.log(`   TODAY  ${block.startMin}-${block.endMin}  ${block.taskTitle}`)
}
console.log(`   of which today: ${legacy.filter((b) => b.date === today).length}\n`)

// What the new model holds.
const accepted = store.plans.accepted('week', week)
console.log(`accepted week plan: ${accepted ? `${accepted.id} v${accepted.version}` : 'NONE'}`)
if (accepted) {
  const blocks = store.plans.blocks(accepted.id)
  console.log(`   plan_blocks this week: ${blocks.length}`)
  console.log(`   of which today: ${blocks.filter((b) => b.date === today).length}`)
}

// 'active' is what the screens ask for — tracking a task marks it in progress.
console.log(`\nactive tasks: ${store.tasks.list({ status: 'active' }).length}`)
console.log(`   of which in progress: ${store.tasks.list({ status: 'in_progress' }).length}`)

// What the stat cards and the timeline are computed from.
const stats = new StatsService(store)
const day = stats.day(today)
const weekStats = stats.week(week)
const totals = stats.totals(startMs, endMs)

console.log('\n--- what Today should show ---')
console.log(`Today       ${day.trackedMin} min   sessions ${day.sessionCount}   focus ${day.focusBlocks}`)
console.log(`This week   ${weekStats.trackedMin} min`)
console.log(`Stage hours ${totals.stageMin} min   other ${totals.otherMin} min   total ${totals.totalMin}`)

const timeline = stats.timeline(today)
console.log(`\ntimeline segments today: ${timeline.length}`)
for (const s of timeline) {
  const from = new Date(s.startedAt)
  const to = new Date(s.endedAt)
  const hhmm = (d: Date): string =>
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  console.log(`   ${hhmm(from)}-${hhmm(to)}  ${s.durationMin}m  ${s.taskTitle ?? 'Untracked'}`)
}

console.log(`\nopen segments: ${store.tracking.openSegments().length} (more than one means an orphan)`)
console.log(`running segment: ${store.tracking.currentSegment()?.taskTitle ?? 'none'}`)

store.db.close()
