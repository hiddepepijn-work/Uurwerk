import type { Migration } from './index.js'

/**
 * Tasks that know what has to happen before them.
 *
 * Hidde, 26 Oct 2026: a resit in the agenda should bring its own "check what I have to hand
 * in", a trip its own "pack the bag", and both should come with notifications. Three things
 * were missing for that:
 *
 *   checklist   steps inside one task (passport, charger, tickets) as JSON [{ text, done }]
 *   remind_at   moments chosen for this task alone, JSON ["2026-11-02T09:00", ...]
 *   prep_for    the task or appointment this one prepares, as a ref: "t:<id>" or "a:<id>"
 *
 * And per task or appointment, whether anyone has asked yet if it needs preparation at all:
 * `prep_checks`, keyed by the same ref. No row = not checked yet. A table of its own rather
 * than a column, because appointments live in calendar_events, which the calendar sync owns.
 * It syncs like any user table.
 */
export const migration023: Migration = {
  id: 23,
  name: 'task-prep',
  sql: /* sql */ `
    ALTER TABLE tasks ADD COLUMN checklist TEXT;
    ALTER TABLE tasks ADD COLUMN remind_at TEXT;
    ALTER TABLE tasks ADD COLUMN prep_for  TEXT;

    CREATE TABLE prep_checks (
      ref        TEXT PRIMARY KEY,
      status     TEXT NOT NULL CHECK (status IN ('none', 'asked', 'planned')),
      note       TEXT,
      updated_at INTEGER NOT NULL
    );
  `
}
