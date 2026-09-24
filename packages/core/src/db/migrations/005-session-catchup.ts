import type { Migration } from './index.js'
import { newId } from '../connection.js'

/**
 * Closes the gap between `sessions` and `time_segments`.
 *
 * Migration 004 copied the sessions that existed at the time. Between then and the moment
 * the tracking service takes over, the timer kept writing to `sessions` only — so any hour
 * logged in that window exists in the old table and not in the new one.
 *
 * This migration:
 *   1. adds `legacy_session_id`, so the link between the two tables is explicit rather
 *      than inferred from timestamps every time someone needs to check it
 *   2. back-links the segments 004 already created, matching on start time and task
 *   3. imports every session that still has no segment
 *
 * Being able to say "this segment came from that session" is what makes the import safe
 * to run more than once: a second run finds nothing left to do.
 */

interface SessionRow {
  id: string
  task_id: string | null
  started_at: number
  ended_at: number | null
  note: string | null
  auto_stopped: number
}

export const migration005: Migration = {
  id: 5,
  name: 'session-catchup',
  sql: /* sql */ `
    ALTER TABLE time_segments ADD COLUMN legacy_session_id TEXT;
    CREATE INDEX idx_segments_legacy ON time_segments(legacy_session_id);
  `,
  run(db) {
    // 1. Back-link what migration 004 created. It inserted one segment per session with
    //    the same start time, so the pair is unambiguous.
    const orphanSegments = db.all<{ id: string; started_at: number; task_id: string | null }>(
      'SELECT id, started_at, task_id FROM time_segments WHERE legacy_session_id IS NULL'
    )

    for (const segment of orphanSegments) {
      const match = db.get<{ id: string }>(
        `SELECT id FROM sessions
         WHERE started_at = ? AND (task_id IS ? OR task_id = ?)
         LIMIT 1`,
        [segment.started_at, segment.task_id, segment.task_id]
      )
      if (match) {
        db.run('UPDATE time_segments SET legacy_session_id = ? WHERE id = ?', [match.id, segment.id])
      }
    }

    // 2. Import anything still missing — the hours logged after 004 ran.
    const missing = db.all<SessionRow>(
      `SELECT s.* FROM sessions s
       WHERE NOT EXISTS (SELECT 1 FROM time_segments g WHERE g.legacy_session_id = s.id)
       ORDER BY s.started_at`
    )

    for (const session of missing) {
      const runId = newId()
      db.run('INSERT INTO tracking_runs (id, started_at, ended_at, note) VALUES (?, ?, ?, ?)', [
        runId,
        session.started_at,
        session.ended_at,
        session.note
      ])

      // Area comes from the task where there is one; everything pre-planner was Stage.
      const area =
        db.get<{ area_id: string | null }>(
          `SELECT COALESCE(t.area_id, p.area_id) AS area_id
           FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
           WHERE t.id = ?`,
          [session.task_id]
        )?.area_id ?? 'stage'

      const stageArea = db.get<{ counts: number }>(
        'SELECT counts_as_stage_hours AS counts FROM areas WHERE id = ?',
        [area]
      )

      db.run(
        `INSERT INTO time_segments
           (id, tracking_run_id, task_id, area_id, plan_block_id, started_at, ended_at,
            counts_as_stage_hours, note, completion_reason, auto_stopped, legacy_session_id)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId(),
          runId,
          session.task_id,
          area,
          session.started_at,
          session.ended_at,
          stageArea?.counts ?? 1,
          session.note,
          session.ended_at === null ? null : session.auto_stopped ? 'idle' : 'stopped',
          session.auto_stopped,
          session.id
        ]
      )
    }

    // 3. Every session must now have exactly one segment. Throwing rolls everything back.
    const unmatched =
      db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM sessions s
         WHERE NOT EXISTS (SELECT 1 FROM time_segments g WHERE g.legacy_session_id = s.id)`
      )?.n ?? 0

    if (unmatched > 0) {
      throw new Error(`Session catch-up failed: ${unmatched} sessions still have no time segment.`)
    }
  }
}
