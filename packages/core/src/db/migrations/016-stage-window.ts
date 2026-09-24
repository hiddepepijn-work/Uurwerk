import type { Migration } from './index.js'

/**
 * Internship hours as a window inside the working day, and the lunch break as a standing rule.
 *
 * Before this, a day had one window and the planner filled it with whatever scored highest.
 * That is wrong in a way that only shows up on a report: a fortnight planned from nine in
 * the morning to ten at night quietly scheduled internship work at half past nine in the
 * evening, and those hours are not internship hours — nobody is at the internship then.
 *
 * So the day gets two boundaries instead of one. `start_min`/`end_min` stay what they
 * always were: when you are willing to work at all. `stage_start_min`/`stage_end_min` say
 * which part of that belongs to the internship. Stage work goes inside; school and personal
 * work go outside, before it or after it. Null on both means no internship hours that day.
 *
 * The defaults are Monday to Friday, nine to six. Existing rows — including the per-day
 * overrides of a fortnight already entered by hand — are given the same, because a row
 * left at null would take internship work out of the plan entirely rather than merely
 * moving it.
 *
 * Lunch is a `recurring_commitment` rather than a third pair of columns. It is exactly what
 * that table is for: a weekday, a window, every week. Half an hour at half past twelve, and
 * the planner already treats a commitment as a wall.
 */
export const migration016: Migration = {
  id: 16,
  name: 'stage-window',
  sql: /* sql */ `
    ALTER TABLE availability ADD COLUMN stage_start_min INTEGER;
    ALTER TABLE availability ADD COLUMN stage_end_min   INTEGER;

    -- Every weekday row that exists, recurring pattern and week overrides alike.
    UPDATE availability
       SET stage_start_min = 540, stage_end_min = 1080
     WHERE weekday BETWEEN 1 AND 5;
  `,
  run(db) {
    // The recurring pattern, seeded only where the user has not written one. Weekdays are
    // internship days; the weekend is open for other work and closed to the internship.
    const pattern: Array<[number, number, number, number | null, number | null]> = [
      [1, 9 * 60, 18 * 60, 9 * 60, 18 * 60],
      [2, 9 * 60, 18 * 60, 9 * 60, 18 * 60],
      [3, 9 * 60, 18 * 60, 9 * 60, 18 * 60],
      [4, 9 * 60, 18 * 60, 9 * 60, 18 * 60],
      [5, 9 * 60, 18 * 60, 9 * 60, 18 * 60],
      [6, 10 * 60, 18 * 60, null, null],
      [7, 10 * 60, 18 * 60, null, null]
    ]

    for (const [weekday, startMin, endMin, stageStart, stageEnd] of pattern) {
      const existing = db.get<{ id: string }>(
        'SELECT id FROM availability WHERE week IS NULL AND weekday = ?',
        [weekday]
      )
      if (existing) continue

      db.run(
        `INSERT INTO availability
           (id, week, weekday, start_min, end_min, allowed_areas, area_targets, enabled,
            stage_start_min, stage_end_min)
         VALUES (?, NULL, ?, ?, ?, '[]', '{}', 1, ?, ?)`,
        [`availability-default-${weekday}`, weekday, startMin, endMin, stageStart, stageEnd]
      )
    }

    // Lunch: half an hour, every working day, in the middle of the internship window.
    // `INSERT OR IGNORE` on a fixed id so re-running or restoring a backup cannot stack
    // five identical breaks on top of each other.
    const today = new Date().toISOString().slice(0, 10)
    for (const weekday of [1, 2, 3, 4, 5]) {
      db.run(
        `INSERT OR IGNORE INTO recurring_commitments
           (id, title, weekday, start_min, end_min, kind, area_id, organization_id,
            active_from, active_to, archived, created_at)
         VALUES (?, 'Pauze', ?, 750, 780, 'break', NULL, NULL, ?, NULL, 0, ?)`,
        [`commitment-lunch-${weekday}`, weekday, today, Date.now()]
      )
    }
  }
}
