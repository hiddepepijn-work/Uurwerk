/**
 * The default shape of an internship day, in one place.
 *
 * Nine to six, Monday to Friday. It is a default and not a rule — every day and every
 * weekday can be given its own window — but it is the answer whenever nothing has been
 * said yet, and it has to be the same answer in the planner, in the editor and in the
 * migration that seeds the pattern. Three copies of "nine to six" would drift.
 *
 * The weekend has no internship hours at all. That is not the same as "no work": a Saturday
 * is open for school and personal work, it simply cannot hold internship time.
 */

import type { IsoDate } from '../contract/types.js'
import { isoWeekday } from '../util/time.js'

export const DEFAULT_STAGE_START_MIN = 9 * 60
export const DEFAULT_STAGE_END_MIN = 18 * 60

export interface StageWindow {
  startMin: number
  endMin: number
}

/** Null for Saturday and Sunday. */
export function defaultStageWindowForWeekday(weekday: number): StageWindow | null {
  if (weekday < 1 || weekday > 5) return null
  return { startMin: DEFAULT_STAGE_START_MIN, endMin: DEFAULT_STAGE_END_MIN }
}

export const defaultStageWindowOn = (date: IsoDate): StageWindow | null =>
  defaultStageWindowForWeekday(isoWeekday(date))
