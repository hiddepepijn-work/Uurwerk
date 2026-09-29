/**
 * Numbers more than one tab shows, computed once from the state so the overview, the trip tab
 * and the Today card never disagree.
 */

import type { IsoDate, MoneyState } from '@core/contract/types.js'
import { addDays, addMonths, daysBetween, monthOf, monthsBetween, weekday } from '@core/money/dates.js'
import { shiftTotal } from '@core/money/pay.js'
import { costsIn, fixedPayments, monthPlan, phaseFor, PLAN_TEMPLATE, weeklyPayments } from '@core/money/plan.js'
import { project, type Projection } from '@core/money/projection.js'
import { extraBalance } from '@core/money/status.js'

/** The shift count the plan asks for: the most any shift month needs. */
export function plannedShifts(state: MoneyState, today: IsoDate): number {
  const goalMonth = state.goal ? monthOf(state.goal.date) : monthOf(today)
  const from = monthOf(today)
  let most = 0
  for (const month of from <= goalMonth ? monthsBetween(from, goalMonth) : []) {
    const plan = monthPlan(state, month)
    if (plan.hasShifts) most = Math.max(most, plan.shiftsNeeded)
  }
  return most
}

export interface TripOutlook {
  projection: Projection
  shifts: number
  /** Short on the date after Extra helps; 0 = on track. */
  shortAfterExtraCents: number
  fromExtraCents: number
}

export function tripOutlook(state: MoneyState, today: IsoDate, shifts = plannedShifts(state, today)): TripOutlook | null {
  const projection = project(state, { today, shiftsPerMonth: shifts })
  if (!projection) return null
  const available = Math.max(0, extraBalance(state)) + projection.extraCents
  const fromExtraCents = Math.min(projection.shortCents, available)
  return { projection, shifts, fromExtraCents, shortAfterExtraCents: projection.shortCents - fromExtraCents }
}

export interface Upcoming {
  date: IsoDate
  name: string
  sub: string
  cents: number
}

/** Money moving in the next `days` days: costs, fixed and weekly pay, pay for worked shifts, milestones. */
export function upcoming(state: MoneyState, today: IsoDate, days = 7): Upcoming[] {
  const until = addDays(today, days - 1)
  const out: Upcoming[] = []
  for (const month of monthsBetween(monthOf(today), monthOf(until))) {
    for (const { cost, date } of costsIn(state.costs, month)) out.push({ date, name: cost.name, sub: cost.category, cents: -cost.amountCents })
    for (const payment of fixedPayments(state.incomes, month)) out.push({ date: payment.date, name: payment.name, sub: 'inkomen', cents: payment.amountCents })
    for (const payment of weeklyPayments(state.incomes, month)) out.push({ date: payment.date, name: payment.name, sub: 'weekloon', cents: payment.amountCents })
  }
  // A Thursday pays the shifts of the week before last.
  if (state.profile) {
    for (let date = today; date <= until; date = addDays(date, 1)) {
      if (weekday(date) !== 4) continue
      const worked = shiftsForPayday(state, date)
      if (worked.length === 0) continue
      const cents = worked.reduce((sum, shift) => sum + shiftTotal(state.profile!, shift.template), 0)
      out.push({ date, name: 'Adecco-loon', sub: `${worked.length} ${worked.length === 1 ? 'dienst' : 'diensten'} · voorspeld`, cents })
    }
  }
  for (const milestone of state.milestones) {
    if (!milestone.paid) out.push({ date: milestone.date, name: milestone.name, sub: 'uit de reispot', cents: -milestone.amountCents })
  }
  return out.filter((item) => item.date >= today && item.date <= until).sort((a, b) => a.date.localeCompare(b.date))
}

/** The shifts a Thursday pays: Monday–Sunday of the week before last. */
export function shiftsForPayday(state: MoneyState, payday: IsoDate): MoneyState['shifts'] {
  const from = addDays(payday, -10)
  const to = addDays(payday, -4)
  return state.shifts.filter((shift) => shift.date >= from && shift.date <= to)
}

/** Monday 12:00 is the deadline for last week's hours; returns that Monday and its shifts. */
export function hoursDeadline(state: MoneyState, today: IsoDate): { monday: IsoDate; shifts: MoneyState['shifts'] } | null {
  const monday = addDays(today, (8 - weekday(today)) % 7)
  const shifts = state.shifts.filter((shift) => shift.date >= addDays(monday, -7) && shift.date < monday)
  return shifts.length > 0 ? { monday, shifts } : null
}

export function perShift(state: MoneyState): number {
  return state.profile ? shiftTotal(state.profile, PLAN_TEMPLATE) : 0
}

/** The phase today falls in, and where in it. */
export function phaseProgress(state: MoneyState, today: IsoDate): { name: string; day: number; days: number; until: IsoDate } | null {
  const phase = phaseFor(state.phases, monthOf(today))
  if (!phase || today < phase.from) return null
  const days = daysBetween(phase.from, phase.until) + 1
  return { name: phase.name, day: Math.min(days, daysBetween(phase.from, today) + 1), days, until: phase.until }
}

/** The last month that ended, if it belongs to a phase and is not closed yet. */
export function monthToClose(state: MoneyState, today: IsoDate): string | null {
  const previous = addMonths(monthOf(today), -1)
  if (!phaseFor(state.phases, previous)) return null
  return state.closings.some((closing) => closing.month === previous) ? null : previous
}
