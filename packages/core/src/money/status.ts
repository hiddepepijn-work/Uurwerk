/**
 * Where things stand today: the budget this month, the goal pot, the Extra account, and what
 * closing a month would move where.
 */

import type { IsoDate, IsoMonth, MoneyState } from '../contract/types.js'
import { daysBetween, daysInMonth, lastOfMonth, monthOf } from './dates.js'
import { monthPlan } from './plan.js'
import { paidFromPot, savedSoFar, shiftPayIn } from './projection.js'

export { shiftPayIn }

/** Spent from the budget in a month: typed in, plus card payments the bank sorted there. */
export function spentIn(state: MoneyState, month: IsoMonth): number {
  const typed = state.entries.filter((entry) => entry.kind === 'spend' && monthOf(entry.date) === month).reduce((total, entry) => total + entry.amountCents, 0)
  const banked = state.transactions.filter((transaction) => transaction.kind === 'spend' && monthOf(transaction.date) === month).reduce((total, transaction) => total - transaction.amountCents, 0)
  return typed + banked
}

/** Taken from the locked savings for something that was not planned, in a month. */
export function borrowedIn(state: MoneyState, month: IsoMonth): number {
  return state.transactions.filter((transaction) => transaction.kind === 'borrowed' && monthOf(transaction.date) === month).reduce((total, transaction) => total + Math.abs(transaction.amountCents), 0)
}

export interface BudgetStatus {
  month: IsoMonth
  budgetCents: number
  spentCents: number
  leftCents: number
  /** Days from today to the end of the month, today included. */
  daysLeft: number
  perDayCents: number
  /** What should have been spent by today at an even pace. */
  scheduleCents: number
  /** Positive: under schedule by this much. */
  aheadCents: number
}

export function budgetStatus(state: MoneyState, today: IsoDate): BudgetStatus {
  const month = monthOf(today)
  const budgetCents = monthPlan(state, month).budgetCents
  const spentCents = spentIn(state, month)
  const leftCents = budgetCents - spentCents
  const days = daysInMonth(month)
  const dayOfMonth = Number(today.slice(8, 10))
  const daysLeft = daysBetween(today, lastOfMonth(month)) + 1
  const scheduleCents = Math.round((budgetCents * dayOfMonth) / days)
  return {
    month,
    budgetCents,
    spentCents,
    leftCents,
    daysLeft,
    perDayCents: daysLeft > 0 ? Math.round(Math.max(0, leftCents) / daysLeft) : 0,
    scheduleCents,
    aheadCents: scheduleCents - spentCents
  }
}

export interface GoalStatus {
  savedCents: number
  spentCents: number
  inPotCents: number
  targetSavedCents: number
  onAccountCents: number
}

export function goalStatus(state: MoneyState): GoalStatus | null {
  if (!state.goal) return null
  const savedCents = savedSoFar(state)
  const spentCents = paidFromPot(state)
  return {
    savedCents,
    spentCents,
    inPotCents: savedCents - spentCents,
    targetSavedCents: state.goal.onAccountCents + state.milestones.reduce((total, milestone) => total + milestone.amountCents, 0),
    onAccountCents: state.goal.onAccountCents
  }
}

export function extraBalance(state: MoneyState): number {
  return state.entries.filter((entry) => entry.kind === 'extra').reduce((total, entry) => total + entry.amountCents, 0)
}


export interface ClosingProposal {
  month: IsoMonth
  fixedIncomeCents: number
  /** Shift and weekly pay that arrived (recorded), or the weekly estimate when none was. */
  shiftIncomeCents: number
  costsCents: number
  budgetCents: number
  spentCents: number
  availableCents: number
  targetCents: number
  /** From the current account into the pot. */
  savingCents: number
  /** Taken from Extra to reach the target. */
  fromExtraCents: number
  /** Left over after the target: to Extra. */
  extraCents: number
  /** Unspent budget: to Extra. */
  budgetLeftCents: number
  /** Still short after Extra helped. */
  shortCents: number
  /** Borrowed from the locked pot this month; included in the target. */
  borrowedCents: number
}

/**
 * What closing `month` would do. The plan counts what is sure; recorded shift pay replaces the
 * estimate, because by the end of the month it is known.
 */
export function closingProposal(state: MoneyState, month: IsoMonth): ClosingProposal {
  const plan = monthPlan(state, month)
  // With the bank linked, what really came in and went out counts, not what was planned.
  const banked = state.transactions.filter((transaction) => monthOf(transaction.date) === month && !transaction.pending)
  const useBank = banked.length > 0
  const actualIncome = banked.filter((transaction) => transaction.kind === 'income').reduce((total, transaction) => total + transaction.amountCents, 0)
  const actualCosts = banked.filter((transaction) => transaction.kind === 'cost').reduce((total, transaction) => total - transaction.amountCents, 0)
  const fixedIncomeCents = useBank ? actualIncome : plan.fixedIncomeCents
  const costsCents = useBank ? actualCosts : plan.costsCents
  const recorded = shiftPayIn(state, month)
  const shiftIncomeCents = recorded > 0 || useBank ? recorded : plan.weeklyIncomeCents
  const spentCents = spentIn(state, month)
  const borrowedCents = borrowedIn(state, month)
  const availableCents = fixedIncomeCents + shiftIncomeCents - costsCents - plan.budgetCents
  // What was borrowed from the pot goes back first, on top of the plan.
  const targetCents = (plan.savingTargetCents === null ? Math.max(0, availableCents) : plan.savingTargetCents) + borrowedCents
  const savingCents = Math.min(Math.max(0, availableCents), targetCents)
  const gap = targetCents - savingCents
  const fromExtraCents = Math.min(gap, Math.max(0, extraBalance(state)))
  return {
    month,
    fixedIncomeCents,
    shiftIncomeCents,
    costsCents,
    budgetCents: plan.budgetCents,
    spentCents,
    availableCents,
    targetCents,
    savingCents,
    fromExtraCents,
    extraCents: Math.max(0, availableCents - targetCents),
    budgetLeftCents: Math.max(0, plan.budgetCents - spentCents),
    shortCents: gap - fromExtraCents,
    borrowedCents
  }
}
