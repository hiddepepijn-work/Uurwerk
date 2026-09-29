/**
 * Where the goal pot stands between now and the departure date, month by month.
 *
 * Two lines: *saved* is everything that went into the pot, *in the pot* is saved minus what was
 * already paid out of it (flights, vaccinations). Booking a flight lowers the second and not the
 * first, so progress never drops the day you do the right thing.
 *
 * A month's saving lands at its closing, on the first of the next month. The departure month
 * is cut short: only pay that arrives before the date counts, and all of it goes to the pot.
 */

import type { IsoDate, IsoMonth, MoneyMilestone, MoneyState } from '../contract/types.js'
import { addMonths, daysInMonth, firstOfMonth, monthOf, monthsBetween } from './dates.js'
import { fixedPayments, monthPlan, weeklyPayments } from './plan.js'

/** Adecco pay that arrived in a month: typed in, or found by the bank. */
export function shiftPayIn(state: MoneyState, month: IsoMonth): number {
  const typed = state.entries.filter((entry) => entry.kind === 'shiftPay' && monthOf(entry.date) === month).reduce((total, entry) => total + entry.amountCents, 0)
  const banked = state.transactions.filter((transaction) => transaction.kind === 'shiftPay' && monthOf(transaction.date) === month).reduce((total, transaction) => total + transaction.amountCents, 0)
  return typed + banked
}

export interface ProjectionPoint {
  date: IsoDate
  savedCents: number
  inPotCents: number
}

export interface MilestoneCheck {
  milestone: MoneyMilestone
  /** What the pot holds that day, before paying. */
  potCents: number
  shortCents: number
}

export interface ProjectedMonth {
  month: IsoMonth
  availableCents: number
  savingCents: number
  extraCents: number
  shiftsCents: number
}

export interface Projection {
  points: ProjectionPoint[]
  checks: MilestoneCheck[]
  months: ProjectedMonth[]
  finalSavedCents: number
  finalInPotCents: number
  /** What must be in the pot on the date. */
  targetInPotCents: number
  /** Everything to save: on the account plus all milestones. */
  targetSavedCents: number
  shortCents: number
  extraCents: number
}

export interface ProjectionOptions {
  today: IsoDate
  /** Shifts per month in months with shift work. */
  shiftsPerMonth: number
}

/** The first month whose saving has not landed yet. */
export function firstOpenMonth(state: MoneyState, today: IsoDate): IsoMonth {
  if (state.closings.length > 0) {
    const last = state.closings.map((closing) => closing.month).sort().at(-1)!
    return addMonths(last, 1)
  }
  const firstPhase = state.phases.map((phase) => monthOf(phase.from)).sort()[0]
  return firstPhase && firstPhase < monthOf(today) ? firstPhase : monthOf(today)
}

/**
 * The savings account with a known balance: once the bank is linked, that balance is the pot.
 *
 * ABN AMRO shares only current accounts over PSD2. A savings account there is added by hand
 * (uid "manual:…") with the balance on a date; every transfer between it and the current
 * account shows on the current account, so the balance is carried forward from those.
 * Interest is the one thing missed — a few euros a quarter, fixed by updating the balance.
 */
export function potAccount(state: MoneyState): MoneyState['accounts'][number] | null {
  const account = state.accounts.find((item) => item.role === 'spaar' && item.balanceCents !== null) ?? null
  if (!account || !account.uid.startsWith('manual:')) return account
  const iban = account.iban.replace(/\s+/g, '').toUpperCase()
  const since = account.balanceDate ?? '0000-00-00'
  const moved = state.transactions
    .filter((transaction) => transaction.counterIban === iban && transaction.date > since && !transaction.pending)
    .reduce((total, transaction) => total - transaction.amountCents, 0)
  return { ...account, balanceCents: account.balanceCents! + moved }
}

/** Paid by hand, or a bank transaction was sorted to it. */
export function milestonePaid(state: MoneyState, milestone: MoneyMilestone): boolean {
  return milestone.paid || state.transactions.some((transaction) => transaction.kind === 'milestone' && transaction.refId === milestone.id)
}

export function paidFromPot(state: MoneyState): number {
  return state.milestones.filter((milestone) => milestonePaid(state, milestone)).reduce((total, milestone) => total + milestone.amountCents, 0)
}

/**
 * Everything that went into the pot. With the bank linked: the savings balance plus what was
 * already paid out of it. Without: the start plus the savings recorded at closings.
 */
export function savedSoFar(state: MoneyState): number {
  const pot = potAccount(state)
  if (pot) return pot.balanceCents! + paidFromPot(state)
  const saved = state.entries.filter((entry) => entry.kind === 'saving').reduce((total, entry) => total + entry.amountCents, 0)
  return (state.goal?.startCents ?? 0) + saved
}

export function project(state: MoneyState, options: ProjectionOptions): Projection | null {
  const goal = state.goal
  if (!goal) return null

  const goalMonth = monthOf(goal.date)
  const startMonth = firstOpenMonth(state, options.today)
  const months: ProjectedMonth[] = []
  const savings: Array<{ date: IsoDate; cents: number }> = []

  for (const month of startMonth <= goalMonth ? monthsBetween(startMonth, goalMonth) : []) {
    if (month === goalMonth) {
      const arriving = [...fixedPayments(state.incomes, month, goal.date), ...weeklyPayments(state.incomes, month, goal.date)]
      const available = arriving.reduce((total, payment) => total + payment.amountCents, 0)
      months.push({ month, availableCents: available, savingCents: available, extraCents: 0, shiftsCents: 0 })
      if (available > 0) savings.push({ date: goal.date, cents: available })
      continue
    }
    const plan = monthPlan(state, month)
    // A month outside every phase has no plan to save by: it is not counted either way.
    if (!plan.phase) continue
    // What was actually paid out counts for a month that is over, and for the part of this
    // month that is; only the rest is an estimate.
    // (A past month with nothing recorded was simply not kept up: the estimate stands.)
    const recorded = shiftPayIn(state, month)
    const todayMonth = monthOf(options.today)
    let shiftsCents: number
    if (plan.hasShifts) {
      const estimate = Math.round(options.shiftsPerMonth * plan.perShiftCents)
      const left = (daysInMonth(month) - Number(options.today.slice(8, 10)) + 1) / daysInMonth(month)
      if (month < todayMonth) shiftsCents = recorded > 0 ? recorded : estimate
      else if (month === todayMonth) shiftsCents = recorded + Math.round(estimate * left)
      else shiftsCents = estimate
    } else {
      shiftsCents = month < todayMonth && recorded > 0 ? recorded : plan.weeklyIncomeCents
    }
    const available = plan.fixedIncomeCents + shiftsCents - plan.costsCents - plan.budgetCents
    const target = plan.savingTargetCents
    const saving = target === null ? Math.max(0, available) : Math.min(Math.max(0, available), target)
    const extra = Math.max(0, available - saving)
    months.push({ month, availableCents: available, savingCents: saving, extraCents: extra, shiftsCents })
    if (saving > 0) savings.push({ date: firstOfMonth(addMonths(month, 1)), cents: saving })
  }

  let saved = savedSoFar(state)
  let inPot = saved - paidFromPot(state)
  const points: ProjectionPoint[] = [{ date: options.today, savedCents: saved, inPotCents: inPot }]
  const checks: MilestoneCheck[] = []

  const due = state.milestones
    .filter((milestone) => !milestonePaid(state, milestone) && milestone.date <= goal.date)
    .sort((a, b) => a.date.localeCompare(b.date))
  // Savings before milestones on the same day: the closing on the 1st pays for what is due that day.
  const events = [
    ...savings.map((saving) => ({ date: saving.date, order: 0, saving: saving.cents, milestone: null as MoneyMilestone | null })),
    ...due.map((milestone) => ({ date: milestone.date, order: 1, saving: 0, milestone }))
  ].sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order)

  for (const event of events) {
    const date = event.date < options.today ? options.today : event.date
    points.push({ date, savedCents: saved, inPotCents: inPot })
    if (event.milestone) {
      checks.push({ milestone: event.milestone, potCents: inPot, shortCents: Math.max(0, event.milestone.amountCents - inPot) })
      inPot -= event.milestone.amountCents
    } else {
      saved += event.saving
      inPot += event.saving
    }
    points.push({ date, savedCents: saved, inPotCents: inPot })
  }
  if (points.at(-1)!.date < goal.date) points.push({ date: goal.date, savedCents: saved, inPotCents: inPot })

  const milestonesTotal = state.milestones.reduce((total, milestone) => total + milestone.amountCents, 0)
  return {
    points,
    checks,
    months,
    finalSavedCents: saved,
    finalInPotCents: inPot,
    targetInPotCents: goal.onAccountCents,
    targetSavedCents: goal.onAccountCents + milestonesTotal,
    shortCents: Math.max(0, goal.onAccountCents - inPot),
    extraCents: months.reduce((total, month) => total + month.extraCents, 0)
  }
}
