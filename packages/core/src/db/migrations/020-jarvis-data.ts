import type { Migration } from './index.js'

/**
 * What Jarvis needs to be a thin language layer over the database rather than a memory.
 *
 * - `created_by` on appointments and plan blocks: 'jarvis' for what he made, NULL for the
 *   rest. "Haal weg wat Jarvis gepland heeft" can then never touch a thing Hidde entered.
 *   An appointment can also carry the task it is for.
 * - `rules`: standing wishes. Hard ones the planner enforces in code; soft ones go into
 *   Jarvis's context as text. The working hours and the internship window stay where the
 *   planner already reads them (availability); this table holds what those cannot say.
 * - `jarvis_day_log`: per day whether the opening and the closing happened, and a short
 *   summary a new conversation starts from. Synced, so the phone and the server agree.
 * - `_jarvis_proposals`: what Jarvis proposed and whether a "ja" carried it out. Leading
 *   underscore: not synced. A proposal belongs to the copy it was made on — the server for
 *   typed conversations, the phone for spoken ones — and runs there.
 */
export const migration020: Migration = {
  id: 20,
  name: 'jarvis-data',
  sql: /* sql */ `
    ALTER TABLE calendar_events ADD COLUMN created_by TEXT CHECK (created_by IN ('jarvis'));
    ALTER TABLE calendar_events ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;
    ALTER TABLE plan_blocks ADD COLUMN created_by TEXT CHECK (created_by IN ('jarvis'));

    CREATE TABLE rules (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL CHECK (kind IN ('hard', 'soft')),
      type        TEXT NOT NULL,
      config      TEXT NOT NULL DEFAULT '{}',
      description TEXT NOT NULL,
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE jarvis_day_log (
      date            TEXT PRIMARY KEY,
      opening_done_at INTEGER,
      closing_done_at INTEGER,
      summary         TEXT
    );

    CREATE TABLE _jarvis_proposals (
      id         TEXT PRIMARY KEY,
      tool       TEXT NOT NULL,
      payload    TEXT NOT NULL,
      summary    TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'executed', 'failed', 'cancelled', 'expired')),
      result     TEXT,
      error      TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX idx_jarvis_proposals_status ON _jarvis_proposals(status, created_at);
  `
}
