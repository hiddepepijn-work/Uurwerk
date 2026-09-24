/**
 * The sharing rule, in one place.
 *
 * Sharing requires the area AND the project to allow it:
 *
 *     effective = area.defaultShare* && (project?.shareable ?? true)
 *
 * The area is a hard privacy boundary. A project can narrow what its area permits; it can
 * never widen it, so a task in Work or Personal cannot be published by flipping a project
 * flag. A task with no project is governed by its area alone.
 *
 * Supervisor and teacher are evaluated separately on purpose — different audiences,
 * different consent. Do not collapse them into one boolean.
 */

import type { Area, Project, Task } from '../contract/types.js'

export interface ShareContext {
  area: Area | null
  project: Project | null
}

/** Nothing is shareable when the area is unknown — absence of a rule is not permission. */
export function sharesWithSupervisor({ area, project }: ShareContext): boolean {
  if (!area?.defaultShareSupervisor) return false
  return project ? project.shareable : true
}

export function sharesWithTeacher({ area, project }: ShareContext): boolean {
  if (!area?.defaultShareTeacher) return false
  return project ? project.shareable : true
}

/** Whether time on this task counts toward internship hours. */
export const countsAsStageHours = (area: Area | null): boolean => area?.countsAsStageHours ?? false

/**
 * Resolves a task's area: its own, else its project's. Returns null when neither is set,
 * which every caller must treat as "not shareable" rather than as a default.
 */
export function resolveAreaId(task: Pick<Task, 'areaId'>, project: Project | null): string | null {
  return task.areaId ?? project?.areaId ?? null
}
