/**
 * The plan for one month: what comes in for sure, what goes out, what the budget and the goal
 * take, and — in a month with shift work — how much the shifts must add to make it fit.
 *
 * "For sure" is the point. Shifts are counted only as what is *needed*; everything a shift
 * brings in above that is extra, and the month closing sends it to the Extra account.
 */

import type { IsoDate, IsoMonth, MoneyCost, MoneyIncome, MoneyPhase, MoneyState } from '../contract/types.js'
import { activeOn, addDays, dayInMonth, firstOfMonth, lastOfMonth, weekdaysInMonth } from './dates.js'
import { shiftTotal } from './pay.js'

/** Adecco pays on Thursday for the week (Monday–Sunday) before last. */
export const PAY_WEEKDAY = 4
/** The template the plan counts in: nights pay best and are what gets planned. */
export const PLAN_TEMPLATE = 'nacht'

export interface Payment {
  date: IsoDate
  name: string
  amountCents: number
}

export interface MonthPlan {
  month: IsoMonth
  phase: MoneyPhase | null
  fixed: Payment[]
  weekly: Payment[]
  costs: Array<{ cost: MoneyCost; date: IsoDate }>
  fixedIncomeCents: number
  weeklyIncomeCents: number
  costsCents: number
  budgetCents: number
  /** Planned saving toward the goal; null = everything left over. */
  savingTargetCents: number | null
  /** Whether a per-shift income runs this month. */
  hasShifts: boolean
  /** What shifts must bring in for costs, budget and saving to fit; 0 without shifts. */
  neededFromShiftsCents: number
  /** One planned shift (net plus travel). */
  perShiftCents: number
  shiftsNeeded: number
  /** Incomes that exist but have no amount yet. */
  open: string[]
}

export function phaseFor(phases: MoneyPhase[], month: IsoMonth): MoneyPhase | null {
  const first = firstOfMonth(month)
  const last = lastOfMonth(month)
  return (
    phases.find((phase) => phase.from <= first && phase.until >= first) ??
    phases.find((phase) => phase.from <= last && phase.until >= first) ??
    null
  )
}

/** Fixed incomes landing in `month`, optionally only those before `before`. */
export function fixedPayments(incomes: MoneyIncome[], month: IsoMonth, before?: IsoDate): Payment[] {
  const out: Payment[] = []
  for (const income of incomes) {
    if (income.kind !== 'fixed' || income.amountCents === null) continue
    const date = dayInMonth(month, income.day ?? 1)
    if (!activeOn(income, date) || (before && date >= before)) continue
    out.push({ date, name: income.name, amountCents: income.amountCents })
  }
  return out
}

/**
 * Weekly pay landing in `month`. The amount is a monthly estimate spread over 52 weeks; a
 * Thursday pays the Monday–Sunday week ending four days earlier, when that week overlaps the
 * income's from/until.
 */
export function weeklyPayments(incomes: MoneyIncome[], month: IsoMonth, before?: IsoDate): Payment[] {
  const out: Payment[] = []
  for (const income of incomes) {
    if (income.kind !== 'weekly' || income.amountCents === null) continue
    const perWeek = Math.round((income.amountCents * 12) / 52)
    for (const date of weekdaysInMonth(month, PAY_WEEKDAY)) {
      if (before && date >= before) continue
      const weekStart = addDays(date, -10)
      const weekEnd = addDays(date, -4)
      const overlaps = (income.from === null || weekEnd >= income.from) && (income.until === null || weekStart <= income.until)
      if (overlaps) out.push({ date, name: income.name, amountCents: perWeek })
    }
  }
  return out
}

export function costsIn(costs: MoneyCost[], month: IsoMonth): Array<{ cost: MoneyCost; date: IsoDate }> {
  return costs
    .map((cost) => ({ cost, date: dayInMonth(month, cost.day) }))
    .filter(({ cost, date }) => activeOn(cost, date))
    .sort((a, b) => a.date.localeCompare(b.date))
}

const sum = (items: Array<{ amountCents: number }>): number => items.reduce((total, item) => total + item.amountCents, 0)

export function monthPlan(state: Pick<MoneyState, 'incomes' | 'costs' | 'phases' | 'profile'>, month: IsoMonth): MonthPlan {
  const phase = phaseFor(state.phases, month)
  const fixed = fixedPayments(state.incomes, month)
  const weekly = weeklyPayments(state.incomes, month)
  const costs = costsIn(state.costs, month)
  const fixedIncomeCents = sum(fixed)
  const weeklyIncomeCents = sum(weekly)
  const costsCents = costs.reduce((total, { cost }) => total + cost.amountCents, 0)
  const budgetCents = phase?.budgetCents ?? 0
  const savingTargetCents = phase ? phase.savingCents : 0
  const hasShifts = state.incomes.some((income) => income.kind === 'shifts' && activeOn(income, firstOfMonth(month)))
  const perShiftCents = state.profile ? shiftTotal(state.profile, PLAN_TEMPLATE) : 0
  const neededFromShiftsCents = hasShifts
    ? Math.max(0, costsCents + budgetCents + (savingTargetCents ?? 0) - fixedIncomeCents - weeklyIncomeCents)
    : 0
  return {
    month,
    phase,
    fixed,
    weekly,
    costs,
    fixedIncomeCents,
    weeklyIncomeCents,
    costsCents,
    budgetCents,
    savingTargetCents,
    hasShifts,
    neededFromShiftsCents,
    perShiftCents,
    shiftsNeeded: perShiftCents > 0 ? Math.ceil(neededFromShiftsCents / perShiftCents) : 0,
    open: state.incomes.filter((income) => income.kind === 'open' || (income.kind !== 'shifts' && income.amountCents === null)).map((income) => income.name)
  }
}
