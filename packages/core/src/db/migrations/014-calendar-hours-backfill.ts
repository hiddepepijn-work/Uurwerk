import type { Migration } from './index.js'
import { newId } from '../connection.js'

const MINUTE_MS = 60_000

interface EventRow {
  id: string
  title: string
  starts_at: number
  ends_at: number
  confirmed_min: number | null
  area_id: string | null
}

/**
 * Hours for appointments that were classified before anything turned them into hours.
 *
 * `registration_mode` and `counts_as_worked` have been stored on calendar events since
 * migration 013, but nothing ever wrote the matching `time_segments` row — and every reader
 * of hours in this app reads segments and only segments. So an event you marked as counting
 * toward your internship contributed exactly nothing to the week total, the stage-hours
 * card, planned-versus-actual, or the supervisor's document. `reconciled_segment_id` was in
 * the schema from the start, waiting for the writer that never arrived.
 *
 * The service now writes that segment on every classification, which fixes it going forward.
 * This fixes what is already in the database, so a week you classified last month reports the
 * hours you actually agreed to rather than silently dropping them.
 *
 * Idempotent by construction: only events with no `reconciled_segment_id` are touched, and
 * each one gets that id set. Running twice cannot double-count.
 */
export const migration014: Migration = {
  id: 14,
  name: 'calendar_hours_backfill',
  run(db) {
    const events = db.all<EventRow>(
      `SELECT id, title, starts_at, ends_at, confirmed_min, area_id
       FROM calendar_events
       WHERE deleted_at IS NULL
         AND cancelled = 0
         AND counts_as_worked = 1
         AND registration_mode <> 'none'
         AND reconciled_segment_id IS NULL
       ORDER BY starts_at`
    )

    for (const event of events) {
      const minutes = event.confirmed_min ?? Math.round((event.ends_at - event.starts_at) / MINUTE_MS)
      if (minutes <= 0) continue

      const endedAt = event.starts_at + minutes * MINUTE_MS

      // The stored flag, resolved from the area as it stands now. There is no earlier answer
      // to preserve — these hours have never been counted, so they have never been reported.
      const countsAsStageHours = event.area_id
        ? (db.get<{ counts: number }>(
            'SELECT counts_as_stage_hours AS counts FROM areas WHERE id = ?',
            [event.area_id]
          )?.counts ?? 0)
        : 0

      // Its own run, closed immediately: an appointment is a self-contained stretch, and it
      // must never look like the open run of a timer someone forgot to stop.
      const runId = newId()
      db.run('INSERT INTO tracking_runs (id, started_at, ended_at, note) VALUES (?, ?, ?, ?)', [
        runId,
        event.starts_at,
        endedAt,
        event.title
      ])

      const segmentId = newId()
      db.run(
        `INSERT INTO time_segments
           (id, tracking_run_id, task_id, area_id, plan_block_id, started_at, ended_at,
            counts_as_stage_hours, note, completion_reason, auto_stopped)
         VALUES (?, ?, NULL, ?, NULL, ?, ?, ?, ?, 'stopped', 0)`,
        [segmentId, runId, event.area_id, event.starts_at, endedAt, countsAsStageHours, event.title]
      )

      db.run('UPDATE calendar_events SET reconciled_segment_id = ? WHERE id = ?', [
        segmentId,
        event.id
      ])
    }
  }
}
