import type { Migration } from './index.js'

/**
 * Internship days end at half past five instead of six.
 *
 * The internship day is two blocks now: nine to half past twelve, lunch, then one to half
 * past five. The planner fills each block whole (range.ts, schedule-builder.ts), so the end
 * of the window is the end of the afternoon block. Only rows still on the old default are
 * moved; a window someone set by hand to another time stays as it is.
 */
export const migration022: Migration = {
  id: 22,
  name: 'stage-half-days',
  sql: /* sql */ `
    UPDATE availability
       SET stage_end_min = 1050
     WHERE stage_end_min = 1080;
  `
}
