/**
 * When work can actually happen.
 *
 * The planner asks this before it asks anything about priorities: a perfectly ranked task
 * with nowhere to go is not a plan. This turns the working window, the breaks, the
 * meetings and the blocks already placed into a plain list of free gaps.
 *
 * Every gap is labelled with *what kind of work* may go in it, which is the second half of
 * the same question. A day that runs from nine to ten at night is not thirteen hours of
 * internship: the internship owns nine to six, and the evening belongs to school and to
 * personal work. A gap on the wrong side of that line is free time for one kind of task and
 * simply does not exist for the other.
 *
 * Buffer is subtracted from what the scheduler is allowed to fill, never from the day
 * itself — a plan that consumes every available minute is a plan that breaks on the first
 * thing that runs late.
 */

import type { StageWindow } from '../../domain/stage-hours.js'
import type {
  Availability,
  FixedEvent,
  IsoDate,
  PlanBlock,
  PlanIntensity
} from '../../contract/types.js'
import { INTENSITY_BUFFER } from '../../contract/types.js'
import { defaultStageWindowOn } from '../../domain/stage-hours.js'
import { isWeekend } from '../../util/time.js'

export interface Gap {
  date: IsoDate
  startMin: number
  endMin: number
  minutes: number
  /**
   * True inside the internship window, false outside it.
   *
   * Read as a hard filter in both directions, not as a preference: internship work may only
   * be placed where this is true, everything else only where it is false.
   */
  stage: boolean
  /**
   * Weekend time. Real capacity — a deadline may well need it — but it is filled only once
   * the working week is full, so an ordinary fortnight does not quietly eat your Saturdays.
   */
  reserve: boolean
}

export type { StageWindow }

export interface DayWindow {
  date: IsoDate
  startMin: number
  endMin: number
  /** Minutes inside the window, before anything is placed. */
  totalMin: number
  /** What the scheduler may fill: total minus what is taken minus the buffer. */
  fillableMin: number
  bufferMin: number
  /** Null on a day with no internship hours at all — a Saturday, or a day off. */
  stage: StageWindow | null
  gaps: Gap[]
}

interface Occupied {
  startMin: number
  endMin: number
}

/** Merges overlapping ranges so a double-booked hour is not counted twice. */
function merge(ranges: Occupied[]): Occupied[] {
  const sorted = [...ranges].sort((a, b) => a.startMin - b.startMin)
  const out: Occupied[] = []

  for (const range of sorted) {
    const last = out[out.length - 1]
    if (last && range.startMin <= last.endMin) {
      last.endMin = Math.max(last.endMin, range.endMin)
    } else {
      out.push({ ...range })
    }
  }
  return out
}

/**
 * The internship window for a date.
 *
 * A stored row answers it outright. Without one the default pattern decides — nine to six
 * on a weekday, nothing at the weekend — clipped to the working window, so a day that only
 * starts at noon does not get internship hours it cannot use.
 */
export function stageWindowFor(
  availability: Availability | null,
  date: IsoDate,
  window: { startMin: number; endMin: number }
): StageWindow | null {
  if (availability) {
    const { stageStartMin, stageEndMin } = availability
    if (stageStartMin === null || stageEndMin === null) return null
    const startMin = Math.max(stageStartMin, window.startMin)
    const endMin = Math.min(stageEndMin, window.endMin)
    return endMin > startMin ? { startMin, endMin } : null
  }

  const fallback = defaultStageWindowOn(date)
  if (!fallback) return null

  const startMin = Math.max(fallback.startMin, window.startMin)
  const endMin = Math.min(fallback.endMin, window.endMin)
  return endMin > startMin ? { startMin, endMin } : null
}

/** Cuts a free stretch on the internship boundaries, so every piece has one answer. */
function label(
  date: IsoDate,
  from: number,
  to: number,
  stage: StageWindow | null,
  reserve: boolean
): Gap[] {
  const gap = (startMin: number, endMin: number, inStage: boolean): Gap[] =>
    endMin > startMin
      ? [{ date, startMin, endMin, minutes: endMin - startMin, stage: inStage, reserve }]
      : []

  if (!stage || to <= stage.startMin || from >= stage.endMin) return gap(from, to, false)

  return [
    ...gap(from, Math.min(to, stage.startMin), false),
    ...gap(Math.max(from, stage.startMin), Math.min(to, stage.endMin), true),
    ...gap(Math.max(from, stage.endMin), to, false)
  ]
}

export function buildDayWindow(input: {
  date: IsoDate
  availability: Availability | null
  events: FixedEvent[]
  /** Blocks already in the plan: fixed events, locked work, anything kept. */
  existing: PlanBlock[]
  intensity: PlanIntensity
  /** Nothing may be scheduled before this — used to keep replanning out of the past. */
  notBeforeMin?: number
  fallback?: { startMin: number; endMin: number }
}): DayWindow {
  const fallback = input.fallback ?? { startMin: 9 * 60, endMin: 18 * 60 }
  const window = input.availability?.enabled === false
    ? { startMin: 0, endMin: 0 }
    : {
        startMin: input.availability?.startMin ?? fallback.startMin,
        endMin: input.availability?.endMin ?? fallback.endMin
      }

  const startMin = Math.max(window.startMin, input.notBeforeMin ?? window.startMin)
  const endMin = Math.max(startMin, window.endMin)
  const totalMin = endMin - startMin
  const stage = stageWindowFor(input.availability, input.date, { startMin, endMin })
  const reserve = isWeekend(input.date)

  const occupied = merge([
    ...input.events.map((event) => ({ startMin: event.startMin, endMin: event.endMin })),
    ...input.existing.map((block) => ({ startMin: block.startMin, endMin: block.endMin }))
  ])

  const gaps: Gap[] = []
  let cursor = startMin

  for (const range of occupied) {
    if (range.endMin <= startMin || range.startMin >= endMin) continue
    const from = Math.max(cursor, startMin)
    const to = Math.min(range.startMin, endMin)
    if (to > from) gaps.push(...label(input.date, from, to, stage, reserve))
    cursor = Math.max(cursor, range.endMin)
  }

  if (cursor < endMin) {
    gaps.push(...label(input.date, cursor, endMin, stage, reserve))
  }

  const freeMin = gaps.reduce((sum, gap) => sum + gap.minutes, 0)
  const bufferMin = Math.round(totalMin * INTENSITY_BUFFER[input.intensity])

  return {
    date: input.date,
    startMin,
    endMin,
    totalMin,
    bufferMin,
    stage,
    // Never negative: a day already fuller than its buffer allows simply has nothing left.
    fillableMin: Math.max(0, freeMin - bufferMin),
    gaps: gaps.filter((gap) => gap.minutes > 0)
  }
}

/**
 * Working minutes between now and a deadline, across the given days.
 *
 * Deadline pressure has to be measured in working time, not calendar time. "Due in three
 * days" means nothing if two of them are a weekend — this is what makes the difference
 * between a task that is comfortable and one that is already too late.
 */
export function workingMinutesUntil(windows: DayWindow[], deadline: IsoDate): number {
  return windows
    .filter((window) => window.date <= deadline)
    .reduce((sum, window) => sum + window.fillableMin, 0)
}
