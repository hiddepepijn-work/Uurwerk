/**
 * Dutch formatting for everything the supervisor sees.
 *
 * The UI itself stays English (matching the mockups); every supervisor-facing string
 * routes through here and through report/nl.ts. Keeping Intl in one file means a second
 * locale later is a config change, not a hunt through the codebase.
 */

import type { IsoDate, IsoWeek } from '../contract/types.js'
import { fromIsoDate, isoWeekNumber, weekRange } from '../util/time.js'

const LOCALE = 'nl-NL'

const longDate = new Intl.DateTimeFormat(LOCALE, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric'
})
const mediumDate = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' })
const shortDate = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short' })
const dayName = new Intl.DateTimeFormat(LOCALE, { weekday: 'long' })
const clock = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' })

const asDate = (input: number | Date | IsoDate): Date =>
  typeof input === 'string' ? fromIsoDate(input) : typeof input === 'number' ? new Date(input) : input

/** "donderdag 8 mei 2025" */
export const formatLongDate = (input: number | Date | IsoDate): string => longDate.format(asDate(input))

/** "8 mei 2025" */
export const formatMediumDate = (input: number | Date | IsoDate): string =>
  mediumDate.format(asDate(input))

/** "8 mei" */
export const formatShortDate = (input: number | Date | IsoDate): string => shortDate.format(asDate(input))

/** "donderdag" */
export const formatDayName = (input: number | Date | IsoDate): string => dayName.format(asDate(input))

/** "09:15" */
export const formatClock = (input: number | Date): string => clock.format(asDate(input))

/** "4 – 10 augustus 2025", collapsing the month when both ends share it. */
export function formatDateRange(from: IsoDate, to: IsoDate): string {
  const a = fromIsoDate(from)
  const b = fromIsoDate(to)
  const sameMonth = a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()
  return sameMonth ? `${a.getDate()} – ${mediumDate.format(b)}` : `${mediumDate.format(a)} – ${mediumDate.format(b)}`
}

/** "Week 32" */
export const formatWeekLabel = (week: IsoWeek): string => `Week ${isoWeekNumber(fromIsoDate(weekRange(week).from))}`

/** "Week 32 · 4 – 10 augustus 2025" */
export function formatWeekWithRange(week: IsoWeek): string {
  const { from, to } = weekRange(week)
  return `${formatWeekLabel(week)} · ${formatDateRange(from, to)}`
}

/**
 * "4u 12m" · "45m" · "0m"
 * Dutch convention: 'u' for uur, no space between number and unit.
 */
export function formatDuration(minutes: number): string {
  const safe = Math.max(0, Math.round(minutes))
  const h = Math.floor(safe / 60)
  const m = safe % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}u`
  return `${h}u ${String(m).padStart(2, '0')}m`
}

/** "01:24:36" — the big timer readout. */
export function formatStopwatch(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return [h, m, sec].map((n) => String(n).padStart(2, '0')).join(':')
}

/** "16,4 uur" — decimal hours with a Dutch comma, for the report tables. */
export function formatDecimalHours(minutes: number, withUnit = true): string {
  const hours = Math.max(0, minutes) / 60
  const text = new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  }).format(hours)
  return withUnit ? `${text} uur` : text
}

/** "+0u 25m" / "-1u 10m" / "0m" — the planned-vs-actual delta. */
export function formatSignedDuration(minutes: number): string {
  const rounded = Math.round(minutes)
  if (rounded === 0) return '0m'
  return `${rounded > 0 ? '+' : '-'}${formatDuration(Math.abs(rounded))}`
}

/** "102,6%" */
export function formatPercent(fraction: number): string {
  return new Intl.NumberFormat(LOCALE, {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  }).format(Number.isFinite(fraction) ? fraction : 0)
}

/** Joins a list the Dutch way: "a, b en c". */
export function formatList(items: string[]): string {
  return new Intl.ListFormat(LOCALE, { style: 'long', type: 'conjunction' }).format(items)
}
