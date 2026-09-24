import type { Migration } from './index.js'

/**
 * Gives an area to tasks that were created without one.
 *
 * Between the tracking rework and the area picker landing in the UI, every task created
 * from the quick-add window, the switcher or the New-task dialog got `area_id = NULL`.
 * An area-less task never counts toward internship hours and can never be shared — and it
 * says so nowhere, which is the worst kind of default.
 *
 * They are assigned to Stage, matching migration 004 and the app's default. Anything that
 * was really personal or paid work can be moved in the editor; the point here is that no
 * task sits in a state where its hours quietly disappear.
 */
export const migration007: Migration = {
  id: 7,
  name: 'task-area-default',
  sql: /* sql */ `
    UPDATE tasks
    SET area_id = COALESCE(
      (SELECT p.area_id FROM projects p WHERE p.id = tasks.project_id),
      'stage'
    )
    WHERE area_id IS NULL;
  `
}
