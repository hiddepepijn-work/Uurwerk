import type { Migration } from './index.js'

/**
 * Notes on a task: what "done" means, what is needed, who asked for it.
 *
 * Jarvis asks those questions when a task is made and has to remember the answers — for the
 * reminders, for the evening review, for being strict about why something did not happen.
 * A title cannot carry that. Nullable: an old task simply has no notes.
 */
export const migration018: Migration = {
  id: 18,
  name: 'task-notes',
  sql: /* sql */ `
    ALTER TABLE tasks ADD COLUMN notes TEXT;
  `
}
