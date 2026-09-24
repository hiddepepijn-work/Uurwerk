import type { Migration } from './index.js'

/**
 * Links a screenshot to the segment it was taken during.
 *
 * `artifacts.session_id` points at the pre-rework `sessions` table. Since tracking moved to
 * runs and segments, a capture taken today has no session to point at — writing a segment id
 * into that column would violate its foreign key, and writing NULL would throw away the one
 * fact that makes a frame useful in a report: what you were working on when it was taken.
 *
 * The old column stays. It still carries the imported history, and nothing is gained by
 * rebuilding a table to drop a column that is already NULL for every new row.
 */
export const migration008: Migration = {
  id: 8,
  name: 'artifact-segment',
  sql: /* sql */ `
    ALTER TABLE artifacts
      ADD COLUMN time_segment_id TEXT REFERENCES time_segments(id) ON DELETE SET NULL;

    CREATE INDEX idx_artifacts_segment ON artifacts(time_segment_id);
  `
}
