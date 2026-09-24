import type { Migration } from './index.js'

/**
 * Work types: what the activity *is*, independent of who it is for and what it counts as.
 *
 * Research is research whether it happens in the internship, in paid work for the same
 * organization, or for a course. Encoding that three times — stage_research, work_research,
 * school_research — would make every report ask "which of these three means research?" and
 * would guarantee they drift apart.
 *
 * So a task carries three orthogonal facts:
 *
 *   area_id       what it counts as    (Stage / Work / School / Personal)
 *   organization  who it is for        (through its project)
 *   work_type_id  what it is           (research, development, …)
 *
 * Nullable, and no task is assigned one here: an unlabelled task is honest, and guessing a
 * work type from a title would be a worse default than leaving it blank.
 */
export const migration010: Migration = {
  id: 10,
  name: 'work-types',
  sql: /* sql */ `
    CREATE TABLE work_types (
      id         TEXT PRIMARY KEY,
      slug       TEXT NOT NULL UNIQUE,
      name       TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      archived   INTEGER NOT NULL DEFAULT 0
    );

    ALTER TABLE tasks
      ADD COLUMN work_type_id TEXT REFERENCES work_types(id) ON DELETE SET NULL;

    CREATE INDEX idx_tasks_work_type ON tasks(work_type_id);
  `,
  run(db) {
    // A starting set, not a fixed one — they are rows precisely so you can add your own.
    const types = [
      { slug: 'research', name: 'Research' },
      { slug: 'development', name: 'Development' },
      { slug: 'analysis', name: 'Analysis' },
      { slug: 'fieldwork', name: 'Fieldwork' },
      { slug: 'documentation', name: 'Documentation' },
      { slug: 'meeting', name: 'Meeting' },
      { slug: 'coursework', name: 'Coursework' }
    ]

    types.forEach((type, index) => {
      db.run(
        `INSERT OR IGNORE INTO work_types (id, slug, name, sort_order, archived)
         VALUES (?, ?, ?, ?, 0)`,
        [`work-type-${type.slug}`, type.slug, type.name, index]
      )
    })
  }
}
