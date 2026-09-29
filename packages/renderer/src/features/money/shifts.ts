import type { IsoDate, MoneyState } from '@core/contract/types.js'
import { addDays, lastOfMonth, monthOf, weekday } from '@core/money/dates.js'
import { shiftTotal } from '@core/money/pay.js'
import { shiftsForPayday } from './derive.js'

/**
 * Shift pay still to come this month: the Thursdays from today on, each paying the shifts of
 * the week before last. Planned shifts count too — they are the plan.
 */
export function derivedShiftsThisMonth(state: MoneyState, today: IsoDate): { expectedCents: number; expectedCount: number } {
  if (!state.profile) return { expectedCents: 0, expectedCount: 0 }
  const end = lastOfMonth(monthOf(today))
  const paid = new Set(state.entries.filter((entry) => entry.kind === 'shiftPay').map((entry) => entry.date))
  let expectedCents = 0
  let expectedCount = 0
  for (let date = today; date <= end; date = addDays(date, 1)) {
    if (weekday(date) !== 4 || paid.has(date)) continue
    for (const shift of shiftsForPayday(state, date)) {
      expectedCents += shiftTotal(state.profile, shift.template)
      expectedCount += 1
    }
  }
  return { expectedCents, expectedCount }
}
