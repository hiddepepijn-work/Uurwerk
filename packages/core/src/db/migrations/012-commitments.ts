import type { Migration } from './index.js'

/**
 * Standing commitments — the hours that are already spoken for, every week.
 *
 * A supermarket shift is not a meeting. `fixed_events` holds dated, one-off things, and
 * entering "Tuesday evening, every week, indefinitely" as fifty-two of those would be an
 * absurd way to say a simple thing — and impossible to change afterwards without editing
 * fifty-two rows.
 *
 * So a commitment is a *rule*: a weekday, a window, and the period it applies to. It is
 * expanded into occurrences when a date range is read, and a dated `fixed_events` row still
 * wins for a specific day, which is how "no shift this Tuesday" gets expressed.
 *
 * It carries an area and an organization for the same reason everything else does: a shift
 * at one employer is Work, a shift at another is also Work, and the two must stay
 * distinguishable in every total without inventing a second Work area.
 */
export const migration012: Migration = {
  id: 12,
  name: 'commitments',
  sql: /* sql */ `
    CREATE TABLE recurring_commitments (
      id              TEXT PRIMARY KEY,
      title           TEXT NOT NULL,
      -- 1 = Monday .. 7 = Sunday, matching the availability table.
      weekday         INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
      start_min       INTEGER NOT NULL,
      end_min         INTEGER NOT NULL,
      -- 'unavailable' blocks planning outright; 'meeting' is a commitment you are at.
      kind            TEXT NOT NULL DEFAULT 'unavailable'
                      CHECK (kind IN ('meeting','break','unavailable')),
      area_id         TEXT REFERENCES areas(id) ON DELETE SET NULL,
      organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
      -- The period the rule applies to. A null end means "until further notice".
      active_from     TEXT NOT NULL,
      active_to       TEXT,
      archived        INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL,
      CHECK (end_min > start_min)
    );

    CREATE INDEX idx_commitments_weekday ON recurring_commitments(weekday, archived);
  `,
  run(db) {
    // A third organization, so shift hours are Work for *someone specific* rather than
    // being lumped in with other non-internship work.
    db.run(
      `INSERT OR IGNORE INTO organizations (id, slug, name, archived, created_at)
       VALUES ('organization-jumbo', 'jumbo', 'Jumbo', 0, ?)`,
      [Date.now()]
    )
  }
}
