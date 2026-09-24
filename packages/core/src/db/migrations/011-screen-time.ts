import type { Migration } from './index.js'

/**
 * Screen time — how long the machine was awake, which is not how long you worked.
 *
 * Tracked time answers "what did I spend the day on". This answers "how long was the laptop
 * on at all", and the gap between the two is the interesting part: an eleven-hour day with
 * six hours tracked is a different day from an eleven-hour day with ten.
 *
 * Stored as one accumulating row per local day rather than as intervals. A day total is the
 * only thing anything asks for, intervals would be an order of magnitude more rows, and a
 * crash can then lose at most one minute instead of a whole open interval.
 *
 * It starts empty and starts counting from the first launch after this migration — there is
 * no way to reconstruct last week's uptime, and inventing it would be worse than a gap.
 */
export const migration011: Migration = {
  id: 11,
  name: 'screen-time',
  sql: /* sql */ `
    CREATE TABLE device_awake (
      date       TEXT PRIMARY KEY,
      awake_min  INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
  `,
  run(db) {
    /**
     * Default colours for the four system areas, re-stepped so the statistics charts are
     * readable by everyone.
     *
     * The originals were picked per area in isolation and two of them — the violet seeded
     * for School and the purple of Personal — are 2.8 ΔE apart under protanopia, which is
     * the same bar twice for a red-green colourblind reader. These four were validated as a
     * set against the dark chart surface.
     *
     * Only rows still holding their seeded colour are touched: a colour you chose yourself
     * is a decision, and this must not overwrite it.
     */
    const defaults: Array<[id: string, was: string, now: string]> = [
      ['stage', '#22C55E', '#16A34A'],
      ['work', '#1B3A5C', '#3B82F6'],
      ['school', '#6D4AFF', '#EC4899'],
      ['personal', '#4A3A1C', '#8B5CF6']
    ]

    for (const [id, was, now] of defaults) {
      db.run('UPDATE areas SET color = ? WHERE id = ? AND color = ?', [now, id, was])
    }
  }
}
