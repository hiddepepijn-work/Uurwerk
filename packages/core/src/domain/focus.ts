import type { Task } from '../contract/types.js'

/**
 * Which tasks put the phone in focus (only bank, WhatsApp and the built-in apps) and close
 * distracting apps on the laptop — until the task is done.
 *
 * Stage work always. Private work only when it is a real job: half an hour or more, like
 * tidying a room — not the two-minute things. School and paid work follow the same rule as
 * private work. A task can override it either way.
 */
export const FOCUS_PRIVATE_MIN = 30

export function needsFocus(task: Pick<Task, 'focusMode' | 'areaId' | 'estimateMin'>): boolean {
  if (task.focusMode === 'always') return true
  if (task.focusMode === 'never') return false
  if (task.areaId === 'stage') return true
  return (task.estimateMin ?? 0) >= FOCUS_PRIVATE_MIN
}
