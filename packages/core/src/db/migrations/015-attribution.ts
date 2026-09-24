import type { Migration } from './index.js'

/**
 * Retro-attribution: splitting a stretch of tracked time across the tasks it went to.
 *
 * Picking a task before you start assumes you know what the next hour holds. On a real day
 * you do three things at once, so the honest input is given afterwards: these tasks, roughly
 * these shares. That input has to become minutes on segments, because every reader of hours
 * in this app reads `time_segments` and only `time_segments`.
 *
 * Two columns make the split honest about what it is:
 *
 * `attribution` — 'tracked' is a segment whose task was chosen while the clock ran, so its
 * start and end are real. 'estimated' is a slice cut out of an unattributed stretch from a
 * percentage, so its duration is meant but its clock times are not. Nothing may present the
 * two as equally precise.
 *
 * `attribution_group` — the id of the stretch a slice was cut from, carried by every slice
 * including the anchor (the original row, reused so screenshots and its id survive). It is
 * what makes the split reversible and what lets the timeline draw one bar with a stacked
 * breakdown instead of three consecutive blocks that never happened in that order.
 *
 * Existing rows are 'tracked' with no group, which is exactly what they are.
 */
export const migration015: Migration = {
  id: 15,
  name: 'attribution',
  sql: /* sql */ `
    ALTER TABLE time_segments
      ADD COLUMN attribution TEXT NOT NULL DEFAULT 'tracked';

    ALTER TABLE time_segments
      ADD COLUMN attribution_group TEXT;

    CREATE INDEX idx_segments_attribution_group ON time_segments(attribution_group);
  `
}
