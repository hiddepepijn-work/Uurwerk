import type { Migration } from './index.js'

/**
 * Whether working on a task locks the phone down to the essentials.
 *
 * 'auto' (the default) leaves it to the rule in core/domain/focus.ts: stage work always,
 * private work only when it is a real job (half an hour or more). 'always' and 'never'
 * are Hidde overriding that rule for one task.
 */
export const migration019: Migration = {
  id: 19,
  name: 'task-focus',
  sql: /* sql */ `
    ALTER TABLE tasks ADD COLUMN focus_mode TEXT NOT NULL DEFAULT 'auto'
      CHECK (focus_mode IN ('auto', 'always', 'never'));
  `
}
