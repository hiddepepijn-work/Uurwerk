/**
 * Time helpers. Local-time by design: a "working day" and a "working week" are local
 * concepts, not UTC ones. Timestamps stay epoch ms; only the boundaries are local.
 */

import type { IsoDate, IsoWeek } from '../contract/types.js'

export const MINUTE_MS = 60_000
export const DAY_MS = 86_400_000

const pad = (n: number): string => String(n).padStart(2, '0')

/** Local 'YYYY-MM-DD'. */
export function toIsoDate(input: number | Date): IsoDate {
  const d = typeof input === 'number' ? new Date(input) : input
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Parses a local 'YYYY-MM-DD' into local midnight. */
export function fromIsoDate(date: IsoDate): Date {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y!, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0)
}

export function startOfDay(input: number | Date): Date {
  const d = typeof input === 'number' ? new Date(input) : new Date(input.getTime())
  d.setHours(0, 0, 0, 0)
  return d
}

export function addDays(input: number | Date, days: number): Date {
  const d = typeof input === 'number' ? new Date(input) : new Date(input.getTime())
  d.setDate(d.getDate() + days)
  return d
}

/** Half-open range [startMs, endMs) covering one local day. */
export function dayRange(date: IsoDate): { startMs: number; endMs: number } {
  const start = fromIsoDate(date)
  return { startMs: start.getTime(), endMs: addDays(start, 1).getTime() }
}

/** Monday of the ISO week containing the given moment. */
export function startOfIsoWeek(input: number | Date): Date {
  const d = startOfDay(input)
  // getDay(): 0=Sunday..6=Saturday. ISO weeks start on Monday.
  const shift = (d.getDay() + 6) % 7
  return addDays(d, -shift)
}

/** ISO 8601 week number, 1..53. */
export function isoWeekNumber(input: number | Date): number {
  const d = startOfIsoWeek(input)
  // The ISO year is the year of the Thursday in that week.
  const thursday = addDays(d, 3)
  const jan1 = new Date(thursday.getFullYear(), 0, 1)
  const firstThursday = addDays(startOfIsoWeek(jan1), 3)
  return Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * DAY_MS)) + 1
}

/** The ISO year — differs from the calendar year in the first and last days of a year. */
export function isoWeekYear(input: number | Date): number {
  return addDays(startOfIsoWeek(input), 3).getFullYear()
}

/** '2025-W32'. */
export function toIsoWeek(input: number | Date): IsoWeek {
  return `${isoWeekYear(input)}-W${pad(isoWeekNumber(input))}`
}

/** Monday..Sunday boundaries of an ISO week key. */
export function weekRange(week: IsoWeek): {
  from: IsoDate
  to: IsoDate
  startMs: number
  endMs: number
  days: IsoDate[]
} {
  const [yearPart, weekPart] = week.split('-W')
  const year = Number(yearPart)
  const weekNo = Number(weekPart)

  // Week 1 is the week containing 4 January.
  const jan4 = new Date(year, 0, 4)
  const monday = addDays(startOfIsoWeek(jan4), (weekNo - 1) * 7)
  const sunday = addDays(monday, 6)
  const days: IsoDate[] = []
  for (let i = 0; i < 7; i++) days.push(toIsoDate(addDays(monday, i)))

  return {
    from: toIsoDate(monday),
    to: toIsoDate(sunday),
    startMs: monday.getTime(),
    endMs: addDays(monday, 7).getTime(),
    days
  }
}

export function nextWeek(week: IsoWeek): IsoWeek {
  return toIsoWeek(addDays(weekRange(week).startMs, 7))
}

export function previousWeek(week: IsoWeek): IsoWeek {
  return toIsoWeek(addDays(weekRange(week).startMs, -7))
}

/** Minutes since local midnight — the planning grid's coordinate system. */
export function minuteOfDay(ms: number): number {
  const d = new Date(ms)
  return d.getHours() * 60 + d.getMinutes()
}

/** Epoch ms for a minute-of-day offset on a given local date. */
export function atMinuteOfDay(date: IsoDate, minute: number): number {
  return fromIsoDate(date).getTime() + minute * MINUTE_MS
}

/** Whole minutes between two timestamps, never negative. */
export function minutesBetween(fromMs: number, toMs: number): number {
  return Math.max(0, Math.round((toMs - fromMs) / MINUTE_MS))
}

// `splitByDay` used to live here, for slicing a midnight-spanning session per day. Nothing
// ever called it: every reader clips with `overlapMinutes` against the range it already has,
// which handles the same case without materialising the slices.

/** Overlap in minutes between two spans. Used for day/week totals. */
export function overlapMinutes(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): number {
  return minutesBetween(Math.max(aStart, bStart), Math.min(aEnd, bEnd))
}

/**
 * ISO weekday: 1 = Monday … 7 = Sunday.
 *
 * `Date.getDay()` counts from Sunday, which disagrees with every weekday column in this
 * database. Converting in one place keeps that off-by-one out of the callers.
 */
export function isoWeekday(date: IsoDate): number {
  return ((fromIsoDate(date).getDay() + 6) % 7) + 1
}

/** Saturday or Sunday. Weekends are plannable, but only as a last resort. */
export const isWeekend = (date: IsoDate): boolean => isoWeekday(date) >= 6
