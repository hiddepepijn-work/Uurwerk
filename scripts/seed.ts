/**
 * Seeds a realistic week into the app database.
 *
 * Run with `npm run seed` while the app is closed. Existing data is left alone unless you
 * pass --reset, which wipes the tables first.
 *
 * This exists so screens can be checked against the mockups, and so the weekly report has
 * something to aggregate before a single real hour has been logged.
 */

import { join } from 'node:path'
import { existsSync, rmSync } from 'node:fs'
import { openStore } from '../packages/core/src/db/index.js'
import { addDays, atMinuteOfDay, startOfIsoWeek, toIsoDate } from '../packages/core/src/util/time.js'

const RESET = process.argv.includes('--reset')

/** Mirrors main/paths.ts — Electron's app.getPath('userData') on Windows. */
function dbPath(): string {
  const appData = process.env['APPDATA'] ?? join(process.env['USERPROFILE'] ?? '.', 'AppData', 'Roaming')
  return join(appData, 'uurwerk', 'uurwerk', 'app.db')
}

const path = dbPath()
if (RESET && existsSync(path)) {
  rmSync(path)
  console.log('Removed the existing database.')
}

const store = openStore(path)

if (store.tasks.list().length > 0 && !RESET) {
  console.log('Database already has tasks — nothing seeded. Use `npm run seed -- --reset` to start over.')
  // Close before leaving: exiting with the WASM database still open trips a libuv assertion.
  store.db.close()
  process.exit(0)
}

// ------------------------------------------------------------------ projects

const margriet = store.projects.create({
  name: 'SDSS De Margriet',
  color: '#1B3A5C',
  // The only project marked shareable: the supervisor sees these names, the rest is masked.
  shareable: true
})
const stinapa = store.projects.create({ name: 'STINAPA Bonaire', color: '#14493F' })
const general = store.projects.create({ name: 'General', color: '#4A3A1C' })

// --------------------------------------------------------------------- tasks

const tasks = [
  { title: 'Build annotation app – labeling workflow', projectId: margriet.id, priority: 'high' as const, estimateMin: 150 },
  { title: 'Prepare GBDA intervention model', projectId: margriet.id, priority: 'high' as const, estimateMin: 180 },
  { title: 'Drone data processing', projectId: stinapa.id, priority: 'high' as const, estimateMin: 120 },
  { title: 'Review literature for coral restoration', projectId: stinapa.id, priority: 'medium' as const, estimateMin: 75 },
  { title: 'Annotation app development', projectId: margriet.id, priority: 'medium' as const, estimateMin: 240 },
  { title: 'Write weekly progress report', projectId: general.id, priority: 'low' as const, estimateMin: 45 },
  { title: 'Update project documentation', projectId: general.id, priority: 'low' as const, estimateMin: 30 },
  { title: 'Email & follow-ups', projectId: general.id, priority: 'low' as const, estimateMin: 45 }
].map((task) => store.tasks.create(task))

// Two of them are already finished this week.
store.tasks.complete(tasks[2]!.id, true)
store.tasks.complete(tasks[6]!.id, true)

// ------------------------------------------------------ tracking and planning

const monday = startOfIsoWeek(Date.now())
const today = new Date()

/**
 * Plans a block by accepting a day plan, the way the app does.
 *
 * This used to write straight into the flat `planned` table, which the versioned plan model
 * replaced — so a seeded week showed no planning anywhere in the UI. Accepting a real plan
 * per day is what makes planned-versus-actual show something.
 */
function planBlock(taskId: string, date: string, startMin: number, endMin: number): void {
  const existing = store.plans.accepted('day', date)
  if (existing) {
    store.plans.addBlock(existing.id, { taskId, date, startMin, endMin, source: 'manual' })
    return
  }
  const draft = store.plans.createDraft({ scope: 'day', periodKey: date, reason: 'Seeded' })
  store.plans.addBlock(draft.id, { taskId, date, startMin, endMin, source: 'manual' })
  store.plans.accept(draft.id)
}

/** One tracked stretch: a run with a single segment, closed. */
function trackBlock(taskId: string, areaId: string | null, startedAt: number, endedAt: number): void {
  const run = store.tracking.startRun(startedAt)
  const segment = store.tracking.startSegment({
    trackingRunId: run.id,
    taskId,
    areaId,
    // Seeded work is internship work, matching the areas migration 004 assigns.
    countsAsStageHours: true,
    at: startedAt
  })
  store.tracking.endSegment(segment.id, endedAt, 'stopped')
  store.tracking.endRun(run.id, endedAt)
}

/** A working day: three tracked blocks with a lunch gap in the middle. */
const SHAPE = [
  { start: 9 * 60 + 15, end: 10 * 60 + 45 },
  { start: 11 * 60, end: 12 * 60 + 30 },
  { start: 13 * 60 + 15, end: 15 * 60 + 5 },
  { start: 15 * 60 + 30, end: 16 * 60 + 40 }
]

let segmentCount = 0
for (let offset = 0; offset < 5; offset++) {
  const day = addDays(monday, offset)
  if (day > today) break
  const date = toIsoDate(day)
  const isToday = date === toIsoDate(today)

  SHAPE.forEach((block, index) => {
    const task = tasks[(offset + index) % 5]!
    const startedAt = atMinuteOfDay(date, block.start)
    const endedAt = atMinuteOfDay(date, block.end)

    // Do not invent hours that have not happened yet on the current day.
    if (isToday && startedAt > Date.now()) return

    trackBlock(task.id, task.areaId, startedAt, Math.min(endedAt, Date.now()))
    segmentCount++

    // Planned deliberately a little wrong, so planned-versus-actual has something to show.
    planBlock(task.id, date, block.start, block.end + (index === 2 ? 15 : -10))
  })
}

// A little planning for next week, so the report's last section is not empty.
const nextMonday = addDays(monday, 7)
planBlock(tasks[1]!.id, toIsoDate(nextMonday), 9 * 60, 12 * 60)
planBlock(tasks[4]!.id, toIsoDate(addDays(nextMonday, 1)), 13 * 60, 16 * 60)

store.db.close()

console.log(`Seeded 3 projects, ${tasks.length} tasks, ${segmentCount} tracked segments.`)
console.log(`Database: ${path}`)
