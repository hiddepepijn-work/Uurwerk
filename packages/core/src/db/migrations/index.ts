/**
 * Append-only migration list.
 *
 * Rules:
 *   1. Never edit a migration that has already run on a real database — add a new one.
 *   2. `id` is the ordering key and is stored in the `_migrations` table.
 *   3. Each `sql` block runs inside a transaction; keep it self-contained.
 */

import type { Db } from '../connection.js'

export interface Migration {
  id: number
  name: string
  /** Schema changes. Runs before `run`. */
  sql?: string
  /**
   * Data migrations that need real logic — ISO week grouping, verification, anything SQL
   * cannot express clearly. Runs inside the same transaction as `sql`, so throwing here
   * rolls the whole migration back and leaves the database on the previous version.
   */
  run?: (db: Db) => void
  /**
   * Set for a table rebuild (create / copy / drop / rename), which is the only way to
   * change a CHECK constraint in SQLite.
   *
   * Dropping a table fires every ON DELETE CASCADE pointing at it, so rebuilding `tasks`
   * with foreign keys enabled would take `planned` and `plan_blocks` down with it. SQLite
   * requires the pragma to be switched off BEFORE the transaction opens — toggling it
   * inside one silently does nothing. The runner also runs `PRAGMA foreign_key_check`
   * afterwards, so a rebuild that breaks a reference fails loudly instead of quietly.
   */
  rebuildsTable?: boolean
}

// Imported after the interface so the split-out migrations can type against it.
import { migration003 } from './003-planner.js'
import { migration004 } from './004-backfill.js'
import { migration005 } from './005-session-catchup.js'
import { migration006 } from './006-task-status.js'
import { migration007 } from './007-task-area-default.js'
import { migration008 } from './008-artifact-segment.js'
import { migration009 } from './009-organizations.js'
import { migration010 } from './010-work-types.js'
import { migration011 } from './011-screen-time.js'
import { migration012 } from './012-commitments.js'
import { migration013 } from './013-calendar.js'
import { migration014 } from './014-calendar-hours-backfill.js'
import { migration015 } from './015-attribution.js'
import { migration016 } from './016-stage-window.js'
import { migration017 } from './017-publish-audience.js'
import { migration018 } from './018-task-notes.js'
import { migration019 } from './019-task-focus.js'

const inlineMigrations: Migration[] = [
  {
    id: 1,
    name: 'init',
    sql: /* sql */ `
      CREATE TABLE projects (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        color      TEXT NOT NULL DEFAULT '#1B3A5C',
        -- drives the online supervisor view: 0 = masked as "Overig werk"
        shareable  INTEGER NOT NULL DEFAULT 0,
        archived   INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE tasks (
        id           TEXT PRIMARY KEY,
        project_id   TEXT REFERENCES projects(id) ON DELETE SET NULL,
        title        TEXT NOT NULL,
        priority     TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('high','medium','low')),
        status       TEXT NOT NULL DEFAULT 'open'   CHECK (status IN ('open','done','archived')),
        estimate_min INTEGER,
        due_date     TEXT,
        sort_order   INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX idx_tasks_status   ON tasks(status);
      CREATE INDEX idx_tasks_project  ON tasks(project_id);
      CREATE INDEX idx_tasks_due      ON tasks(due_date);

      -- the link between hours and to-dos; everything downstream derives from this
      CREATE TABLE sessions (
        id           TEXT PRIMARY KEY,
        task_id      TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        started_at   INTEGER NOT NULL,
        ended_at     INTEGER,
        note         TEXT,
        auto_stopped INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_sessions_started ON sessions(started_at);
      CREATE INDEX idx_sessions_task    ON sessions(task_id);

      CREATE TABLE planned (
        id        TEXT PRIMARY KEY,
        task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        date      TEXT NOT NULL,
        start_min INTEGER NOT NULL,
        end_min   INTEGER NOT NULL
      );
      CREATE INDEX idx_planned_date ON planned(date);

      CREATE TABLE artifacts (
        id          TEXT PRIMARY KEY,
        session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        day         TEXT NOT NULL,
        kind        TEXT NOT NULL CHECK (kind IN ('screenshot','timelapse')),
        path        TEXT NOT NULL,
        captured_at INTEGER NOT NULL,
        -- the report approval gate: only 1 reaches the .docx
        included    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_artifacts_day  ON artifacts(day);
      CREATE INDEX idx_artifacts_kind ON artifacts(kind);

      CREATE TABLE reports (
        week         TEXT PRIMARY KEY,
        generated_at INTEGER,
        docx_path    TEXT,
        summary      TEXT NOT NULL DEFAULT '',
        sent_at      INTEGER
      );

      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `
  },
  {
    id: 2,
    name: 'day_reports',
    sql: /* sql */ `
      -- The end-of-day review: one row per working day.
      --
      -- publish_flags is the wizard's "What will be published" selection, stored as JSON so
      -- reopening the wizard restores what you chose last time.
      --
      -- published_at is the consent stamp. Nothing about a day is visible to the supervisor
      -- until it is set, and clearing it (Unpublish) must remove the remote copies too.
      CREATE TABLE day_reports (
        date          TEXT PRIMARY KEY,
        summary       TEXT NOT NULL DEFAULT '',
        publish_flags TEXT NOT NULL DEFAULT '{}',
        reviewed_at   INTEGER,
        published_at  INTEGER
      );

      -- Tracks what actually left the machine, so Unpublish knows exactly what to delete.
      -- remote_name is randomised: a published image URL must not be guessable from a date.
      CREATE TABLE published_files (
        id          TEXT PRIMARY KEY,
        artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
        day         TEXT NOT NULL,
        remote_name TEXT NOT NULL,
        published_at INTEGER NOT NULL
      );
      CREATE INDEX idx_published_day ON published_files(day);
    `
  }
]

/**
 * Migrations 1 and 2 stay inline for history; anything larger lives in its own file so
 * the list does not become unreadable. Order is by id, and the runner skips ids that the
 * `_migrations` table already records.
 */
export const MIGRATIONS: Migration[] = [
  ...inlineMigrations,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
  migration008,
  migration009,
  migration010,
  migration011,
  migration012,
  migration013,
  migration014,
  migration015,
  migration016,
  migration017,
  migration018,
  migration019
].sort((a, b) => a.id - b.id)
