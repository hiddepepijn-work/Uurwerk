/**
 * Geld speaks Dutch: "€1.061,65", "15 dec", "ma 23 nov". Amounts arrive as cents and leave as
 * text; nothing in between rounds a euro.
 */

import type { IsoDate, IsoMonth } from '@core/contract/types.js'

const exact = new Intl.NumberFormat('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const whole = new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 0 })

/** €1.061,65 — or €1.062 with `round`. A minus sign in front of the euro for negatives. */
export function euro(cents: number, options: { round?: boolean; sign?: boolean } = {}): string {
  const value = Math.abs(cents) / 100
  const body = options.round ? whole.format(Math.round(value)) : exact.format(value)
  const sign = cents < 0 ? '−' : options.sign && cents > 0 ? '+' : ''
  return `${sign}€${body}`
}

/** "12,50", "12.50", "€ 1.061,65", "12" → cents; null when it is not an amount. */
export function parseEuro(input: string): number | null {
  let text = input.replace(/[€\s]/g, '').replace(/^\+/, '')
  if (!text) return null
  const negative = text.startsWith('-') || text.startsWith('−')
  text = text.replace(/^[-−]/, '')
  // A comma is the decimal sign; dots before it are thousands. Without a comma, a dot with
  // exactly two digits after it is a decimal point too ("12.50").
  if (text.includes(',')) text = text.replace(/\./g, '').replace(',', '.')
  else if (!/^\d+\.\d{1,2}$/.test(text)) text = text.replace(/\./g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null
  const cents = Math.round(Number(text) * 100)
  return negative ? -cents : cents
}

/** Cents back to what you would type: 106165 → "1061,65". */
export function euroInput(cents: number | null): string {
  if (cents === null) return ''
  return (cents / 100).toFixed(2).replace('.', ',').replace(/,00$/, '')
}

const MONTHS = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec']
const MONTHS_LONG = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december']
const DAYS = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za']

function parts(date: IsoDate): { y: number; m: number; d: number; weekday: number } {
  const [y, m, d] = date.split('-').map(Number)
  return { y: y!, m: m!, d: d!, weekday: new Date(y!, m! - 1, d!).getDay() }
}

/** "15 dec" */
export function shortDate(date: IsoDate): string {
  const { m, d } = parts(date)
  return `${d} ${MONTHS[m - 1]}`
}

/** "ma 23 nov" */
export function dayDate(date: IsoDate): string {
  const { m, d, weekday } = parts(date)
  return `${DAYS[weekday]} ${d} ${MONTHS[m - 1]}`
}

export function weekdayShort(date: IsoDate): string {
  return DAYS[parts(date).weekday]!
}

/** "november", "november 2026" with `year`. */
export function monthName(month: IsoMonth, year = false): string {
  const [y, m] = month.split('-').map(Number)
  return `${MONTHS_LONG[m! - 1]}${year ? ` ${y}` : ''}`
}

export function monthShort(month: IsoMonth): string {
  return MONTHS[Number(month.slice(5, 7)) - 1]!
}
