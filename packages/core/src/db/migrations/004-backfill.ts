import type { Migration } from './index.js'
import type { Db } from '../connection.js'
import { newId } from '../connection.js'
import { minutesBetween, toIsoWeek, fromIsoDate } from '../../util/time.js'

/**
 * Carries the existing data forward into the planner model.
 *
 * Decisions taken here, all confirmed rather than assumed:
 *   - every existing task and project belongs to Stage; this has been an internship app
 *   - every existing session becomes Stage hours, including sessions with no task
 *   - existing `planned` rows become one accepted, imported week plan per ISO week,
 *     which becomes that week's baseline
 *
 * Nothing is deleted. `sessions` and `planned` stay readable; a later migration drops
 * them once the planner has proven itself in daily use. Both copies are verified by count
 * and by total minutes, and a mismatch throws — which rolls back the whole migration,
 * including migration 003's schema, leaving the database on its previous version.
 */

interface SessionRow {
  id: string
  task_id: string | null
  started_at: number
  ended_at: number | null
  note: string | null
  auto_stopped: number
}

interface PlannedRow {
  id: string
  task_id: string
  date: string
  start_min: number
  end_min: number
}

const STAGE = 'stage'

function seedAreas(db: Db): void {
  // Fixed ids: migrations, defaults and tests all refer to these across installations.
  const areas = [
    { id: STAGE, name: 'Stage', color: '#22C55E', stage: 1, supervisor: 1, teacher: 1, order: 0 },
    { id: 'work', name: 'Work', color: '#1B3A5C', stage: 0, supervisor: 0, teacher: 0, order: 1 },
    { id: 'personal', name: 'Personal', color: '#4A3A1C', stage: 0, supervisor: 0, teacher: 0, order: 2 }
  ]

  for (const area of areas) {
    db.run(
      `INSERT OR IGNORE INTO areas
         (id, name, color, counts_as_stage_hours, default_share_supervisor,
          default_share_teacher, sort_order, archived)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      [area.id, area.name, area.color, area.stage, area.supervisor, area.teacher, area.order]
    )
  }
}

function seedPlanningProfile(db: Db): void {
  db.run(
    `INSERT OR IGNORE INTO planning_profiles
       (id, name, buffer_percentage, minimum_block_min, preferred_block_min,
        maximum_block_min, discovery_block_min, is_default)
     VALUES ('balanced', 'Balanced', 12, 25, 90, 120, 60, 1)`
  )
}

/** Every existing session becomes a single-segment tracking run. */
function migrateSessions(db: Db): void {
  const sessions = db.all<SessionRow>('SELECT * FROM sessions ORDER BY started_at')
  if (sessions.length === 0) return

  for (const session of sessions) {
    const runId = newId()
    db.run('INSERT INTO tracking_runs (id, started_at, ended_at, note) VALUES (?, ?, ?, ?)', [
      runId,
      session.started_at,
      session.ended_at,
      session.note
    ])

    db.run(
      `INSERT INTO time_segments
         (id, tracking_run_id, task_id, area_id, plan_block_id, started_at, ended_at,
          counts_as_stage_hours, note, completion_reason, auto_stopped)
       VALUES (?, ?, ?, ?, NULL, ?, ?, 1, ?, ?, ?)`,
      [
        newId(),
        runId,
        session.task_id,
        // Sessions with no task are imported as Stage too, so historical totals do not
        // silently drop. They stay unassigned and can be corrected by hand later.
        STAGE,
        session.started_at,
        session.ended_at,
        session.note,
        session.ended_at === null ? null : session.auto_stopped ? 'idle' : 'stopped',
        session.auto_stopped
      ]
    )
  }

  verify(
    db,
    'sessions',
    sessions.length,
    sessions.reduce((sum, s) => sum + minutesBetween(s.started_at, s.ended_at ?? s.started_at), 0),
    'time_segments',
    'SELECT COUNT(*) AS n FROM time_segments',
    db
      .all<{ started_at: number; ended_at: number | null }>(
        'SELECT started_at, ended_at FROM time_segments'
      )
      .reduce((sum, s) => sum + minutesBetween(s.started_at, s.ended_at ?? s.started_at), 0)
  )
}

/** Existing planned rows become one accepted, imported week plan per ISO week. */
function migratePlannedBlocks(db: Db): void {
  const planned = db.all<PlannedRow>('SELECT * FROM planned ORDER BY date, start_min')
  if (planned.length === 0) return

  const byWeek = new Map<string, PlannedRow[]>()
  for (const row of planned) {
    const week = toIsoWeek(fromIsoDate(row.date))
    const bucket = byWeek.get(week)
    if (bucket) bucket.push(row)
    else byWeek.set(week, [row])
  }

  const now = Date.now()

  for (const [week, rows] of byWeek) {
    const planId = newId()
    db.run(
      `INSERT INTO plans
         (id, scope, period_key, version, parent_plan_id, status, reason, intensity,
          created_at, accepted_at)
       VALUES (?, 'week', ?, 1, NULL, 'accepted', ?, 'balanced', ?, ?)`,
      [planId, week, 'Imported from the pre-planner schedule', now, now]
    )

    for (const row of rows) {
      db.run(
        `INSERT INTO plan_blocks
           (id, plan_id, task_id, area_id, date, start_min, end_min, kind, title,
            fixed, locked, source, original_block_id, explanation, score)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'task', NULL, 0, 0, 'imported', NULL, NULL, NULL)`,
        [newId(), planId, row.task_id, STAGE, row.date, row.start_min, row.end_min]
      )
    }
  }

  verify(
    db,
    'planned',
    planned.length,
    planned.reduce((sum, row) => sum + (row.end_min - row.start_min), 0),
    'plan_blocks',
    "SELECT COUNT(*) AS n FROM plan_blocks WHERE source = 'imported'",
    db
      .all<{ start_min: number; end_min: number }>(
        "SELECT start_min, end_min FROM plan_blocks WHERE source = 'imported'"
      )
      .reduce((sum, row) => sum + (row.end_min - row.start_min), 0)
  )
}

/**
 * Both conditions must hold before the old rows can ever be dropped: the same number of
 * records, and the same total minutes. Throwing rolls the migration back.
 */
function verify(
  db: Db,
  sourceName: string,
  sourceCount: number,
  sourceMinutes: number,
  targetName: string,
  targetCountSql: string,
  targetMinutes: number
): void {
  const targetCount = db.get<{ n: number }>(targetCountSql)?.n ?? 0

  if (targetCount !== sourceCount) {
    throw new Error(
      `Backfill mismatch: ${sourceCount} ${sourceName} rows produced ${targetCount} ${targetName} rows.`
    )
  }
  if (targetMinutes !== sourceMinutes) {
    throw new Error(
      `Backfill mismatch: ${sourceName} totals ${sourceMinutes} minutes, ` +
        `${targetName} totals ${targetMinutes} minutes.`
    )
  }
}

export const migration004: Migration = {
  id: 4,
  name: 'backfill-planner',
  // No `sql` step: every statement here depends on the areas existing first, and `sql`
  // runs before `run`. Ordering it by hand is clearer than relying on deferred foreign keys.
  run(db) {
    seedAreas(db)
    seedPlanningProfile(db)
    db.run("UPDATE projects SET area_id = 'stage' WHERE area_id IS NULL")
    db.run("UPDATE tasks SET area_id = 'stage' WHERE area_id IS NULL")
    migrateSessions(db)
    migratePlannedBlocks(db)
  }
}
