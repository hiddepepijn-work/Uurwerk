import type { Migration } from './index.js'

/**
 * The ideas pot: "voeg dit idee toe voor de app". An idea is not a task: it has no duration,
 * no deadline and the planner never places it. It belongs to a project when one fits, and is
 * either still open, turned into something (done), or let go (dropped). Synced like the rest.
 */
export const migration021: Migration = {
  id: 21,
  name: 'ideas',
  sql: /* sql */ `
    CREATE TABLE ideas (
      id         TEXT PRIMARY KEY,
      text       TEXT NOT NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      area_id    TEXT,
      status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dropped')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_ideas_project ON ideas(project_id, status);
  `
}
