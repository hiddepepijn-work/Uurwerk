import type { Migration } from './index.js'

/**
 * Widens `tasks.status` to include 'in_progress' and 'blocked'.
 *
 * Migration 003 assumed the repository could enforce the new statuses. It cannot: the
 * CHECK constraint from migration 001 rejects the value before any TypeScript runs, and
 * SQLite has no way to alter a constraint in place. The only route is the documented
 * twelve-step table rebuild — create, copy, drop, rename.
 *
 * Indexes have to be recreated by hand afterwards, since they die with the old table.
 */
export const migration006: Migration = {
  id: 6,
  name: 'task-status-widen',
  // Without this, dropping `tasks` cascades into `planned` and `plan_blocks` and deletes
  // every planned block in the database.
  rebuildsTable: true,
  sql: /* sql */ `
    CREATE TABLE tasks_new (
      id                  TEXT PRIMARY KEY,
      project_id          TEXT REFERENCES projects(id) ON DELETE SET NULL,
      area_id             TEXT REFERENCES areas(id) ON DELETE SET NULL,
      title               TEXT NOT NULL,
      priority            TEXT NOT NULL DEFAULT 'medium'
                          CHECK (priority IN ('high','medium','low')),
      status              TEXT NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open','in_progress','blocked','done','archived')),
      estimate_min        INTEGER,
      due_date            TEXT,
      earliest_start_date TEXT,
      postponed_count     INTEGER NOT NULL DEFAULT 0,
      blocked_reason      TEXT,
      must_do_date        TEXT,
      sort_order          INTEGER NOT NULL DEFAULT 0,
      created_at          INTEGER NOT NULL,
      completed_at        INTEGER
    );

    INSERT INTO tasks_new
      (id, project_id, area_id, title, priority, status, estimate_min, due_date,
       earliest_start_date, postponed_count, blocked_reason, must_do_date, sort_order,
       created_at, completed_at)
    SELECT
       id, project_id, area_id, title, priority, status, estimate_min, due_date,
       earliest_start_date, postponed_count, blocked_reason, must_do_date, sort_order,
       created_at, completed_at
    FROM tasks;

    DROP TABLE tasks;
    ALTER TABLE tasks_new RENAME TO tasks;

    CREATE INDEX idx_tasks_status  ON tasks(status);
    CREATE INDEX idx_tasks_project ON tasks(project_id);
    CREATE INDEX idx_tasks_due     ON tasks(due_date);
    CREATE INDEX idx_tasks_area    ON tasks(area_id);
  `
}
