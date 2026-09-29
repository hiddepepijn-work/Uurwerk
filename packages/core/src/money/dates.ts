/**
 * Calendar arithmetic for Geld, on plain 'YYYY-MM-DD' and 'YYYY-MM' strings.
 *
 * Strings rather than Date objects: they compare with < and >, they survive JSON, and there is
 * no time zone to get wrong. Local calendar days are all money cares about.
 */

import type { IsoDate, IsoMonth } from '../contract/types.js'

const pad = (value: number): string => String(value).padStart(2, '0')

export function monthOf(date: IsoDate): IsoMonth {
  return date.slice(0, 7)
}

export function daysInMonth(month: IsoMonth): number {
  const [y, m] = month.split('-').map(Number)
  return new Date(y!, m!, 0).getDate()
}

/** The date of `day` in `month`, clamped: day 31 in November is the 30th. */
export function dayInMonth(month: IsoMonth, day: number): IsoDate {
  return `${month}-${pad(Math.min(Math.max(1, day), daysInMonth(month)))}`
}

export function firstOfMonth(month: IsoMonth): IsoDate {
  return `${month}-01`
}

export function lastOfMonth(month: IsoMonth): IsoDate {
  return dayInMonth(month, 31)
}

export function addMonths(month: IsoMonth, count: number): IsoMonth {
  const [y, m] = month.split('-').map(Number)
  const index = y! * 12 + (m! - 1) + count
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`
}

/** Months from `from` to `to`, both included. */
export function monthsBetween(from: IsoMonth, to: IsoMonth): IsoMonth[] {
  const out: IsoMonth[] = []
  for (let month = from; month <= to; month = addMonths(month, 1)) out.push(month)
  return out
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const [y, m, d] = date.split('-').map(Number)
  const next = new Date(y!, m! - 1, d! + days)
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`
}

/** 1 = Monday … 7 = Sunday. */
export function weekday(date: IsoDate): number {
  const [y, m, d] = date.split('-').map(Number)
  const day = new Date(y!, m! - 1, d!).getDay()
  return day === 0 ? 7 : day
}

/** Every date in `month` that falls on `day` (1 = Monday … 7 = Sunday). */
export function weekdaysInMonth(month: IsoMonth, day: number): IsoDate[] {
  const out: IsoDate[] = []
  for (let date = firstOfMonth(month); monthOf(date) === month; date = addDays(date, 1)) {
    if (weekday(date) === day) out.push(date)
  }
  return out
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  const [ay, am, ad] = from.split('-').map(Number)
  const [by, bm, bd] = to.split('-').map(Number)
  return Math.round((Date.UTC(by!, bm! - 1, bd!) - Date.UTC(ay!, am! - 1, ad!)) / 86_400_000)
}

/** Whether a from/until pair (either end open) covers `date`. */
export function activeOn(item: { from: IsoDate | null; until: IsoDate | null }, date: IsoDate): boolean {
  return (item.from === null || date >= item.from) && (item.until === null || date <= item.until)
}
