/**
 * Sorting bank transactions into the overview, so it adds up without typing anything in.
 *
 * In order, first match wins:
 *   1. your own rules ("contains 'albert heijn' → budget")
 *   2. between your own accounts: into savings is saving; out of locked savings is a milestone
 *      when one is due around then, otherwise borrowed
 *   3. Adecco in → shift pay
 *   4. a fixed income: about the amount, around its day
 *   5. a fixed cost: the amount to the euro, around its day
 *   6. a card payment for a booked milestone (the flight itself)
 *   7. any other small payment out → the monthly budget
 * What is left (larger payments, unknown money in) waits under "nakijken".
 */

import type { IsoDate, MoneyAccount, MoneyCost, MoneyIncome, MoneyMilestone, MoneyRule, MoneyTransaction, MoneyTransactionKind } from '../../contract/types.js'
import { daysBetween, dayInMonth, monthOf } from '../dates.js'

export interface ClassifyContext {
  accounts: MoneyAccount[]
  costs: MoneyCost[]
  incomes: MoneyIncome[]
  milestones: MoneyMilestone[]
  rules: MoneyRule[]
  /** Already sorted transactions: a milestone taken out once is not taken out again. */
  transactions?: MoneyTransaction[]
}

export interface Classification {
  kind: MoneyTransactionKind | null
  refId: string | null
}

/** Card payments up to this go to the budget on their own; above it, you decide. */
export const BUDGET_LIMIT_CENTS = 15000
const DAY_WINDOW = 6
const MILESTONE_WINDOW = 14

const text = (transaction: MoneyTransaction): string => `${transaction.counterparty} ${transaction.description}`.toLowerCase()

const normaliseIban = (iban: string | null | undefined): string => (iban ?? '').replace(/\s+/g, '').toUpperCase()

function nearDay(date: IsoDate, day: number): boolean {
  // The expected date in this month and the neighbouring ones: a cost due on the 1st can land on the 30th.
  for (const offset of [-1, 0, 1]) {
    const [y, m] = monthOf(date).split('-').map(Number)
    const index = y! * 12 + (m! - 1) + offset
    const month = `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`
    if (Math.abs(daysBetween(dayInMonth(month, day), date)) <= DAY_WINDOW) return true
  }
  return false
}

function activeOn(item: { from: IsoDate | null; until: IsoDate | null }, date: IsoDate): boolean {
  // Some slack at the ends: the last payment of a cost may land a few days after its end date.
  return (item.from === null || daysBetween(item.from, date) >= -DAY_WINDOW) && (item.until === null || daysBetween(item.until, date) <= DAY_WINDOW)
}

/**
 * The milestone this money is for: due within two weeks, and still (partly) open. `exact`: the
 * amount must be close (a card payment for the flight itself); otherwise it may be part of it
 * (taking money out of the pot for it).
 */
function dueMilestone(context: ClassifyContext, transaction: MoneyTransaction, exact: boolean): MoneyMilestone | null {
  const amount = Math.abs(transaction.amountCents)
  const taken = (milestone: MoneyMilestone): number =>
    (context.transactions ?? [])
      .filter((other) => other.id !== transaction.id && other.kind === 'milestone' && other.refId === milestone.id && other.amountCents > 0 === transaction.amountCents > 0)
      .reduce((total, other) => total + Math.abs(other.amountCents), 0)
  return (
    context.milestones
      .filter((milestone) => Math.abs(daysBetween(milestone.date, transaction.date)) <= MILESTONE_WINDOW)
      .filter((milestone) => {
        const open = milestone.amountCents - taken(milestone)
        return exact ? Math.abs(amount - milestone.amountCents) <= milestone.amountCents * 0.1 && open > 0 : amount <= open * 1.1 && open > 0
      })
      .sort((a, b) => Math.abs(daysBetween(a.date, transaction.date)) - Math.abs(daysBetween(b.date, transaction.date)))[0] ?? null
  )
}

export function classify(transaction: MoneyTransaction, context: ClassifyContext): Classification {
  const haystack = text(transaction)
  for (const rule of context.rules) {
    if (rule.pattern && haystack.includes(rule.pattern.toLowerCase())) return { kind: rule.kind, refId: rule.refId }
  }

  const account = context.accounts.find((item) => item.uid === transaction.accountUid)
  const own = context.accounts.find((item) => normaliseIban(item.iban) === normaliseIban(transaction.counterIban))
  const incoming = transaction.amountCents > 0

  if (own) {
    // Money leaving the savings: seen from the savings account itself (when the bank shares it)
    // or, at ABN AMRO where it does not, as money arriving on the current account from it.
    const fromSavings = (account?.role === 'spaar' && !incoming) || (account?.role !== 'spaar' && own.role === 'spaar' && incoming)
    const intoSavings = account?.role !== 'spaar' && own.role === 'spaar' && !incoming
    if (intoSavings) return { kind: 'saving', refId: null }
    if (fromSavings) {
      const savings = own.role === 'spaar' ? own : account!
      const locked = savings.lockedUntil !== null && transaction.date < savings.lockedUntil
      if (!locked) return { kind: 'transfer', refId: null }
      const milestone = dueMilestone(context, transaction, false)
      return milestone ? { kind: 'milestone', refId: milestone.id } : { kind: 'borrowed', refId: null }
    }
    return { kind: 'transfer', refId: null }
  }

  // Your own name on the other side: money between your own accounts (Revolut, a second account).
  const holders = context.accounts.map((item) => item.name.toLowerCase()).filter((name) => name.length > 3)
  if (holders.includes(transaction.counterparty.toLowerCase())) return { kind: 'transfer', refId: null }

  // Interest and the like on the savings account: in the balance, not in any plan.
  if (account?.role === 'spaar') return { kind: 'ignore', refId: null }

  if (incoming) {
    if (haystack.includes('adecco')) return { kind: 'shiftPay', refId: null }
    // A Tikkie paid back: your share of something shared, so it lowers what the budget spent.
    if (haystack.includes('tikkie')) return { kind: 'spend', refId: null }
    const fixed = context.incomes.filter((income) => income.kind === 'fixed' && income.amountCents !== null && activeOn(income, transaction.date))
    // The name first ("Jumbo" in "Jumbo Supermarkten"), then the closest amount around its day.
    const named = fixed.find((income) => income.name.toLowerCase().split(/[^a-z0-9]+/).some((word) => word.length >= 4 && haystack.includes(word)))
    if (named) return { kind: 'income', refId: named.id }
    const byAmount = fixed
      .filter((income) => Math.abs(transaction.amountCents - income.amountCents!) <= Math.max(500, income.amountCents! * 0.05) && nearDay(transaction.date, income.day ?? 1))
      .sort((x, y) => Math.abs(transaction.amountCents - x.amountCents!) - Math.abs(transaction.amountCents - y.amountCents!))[0]
    if (byAmount) return { kind: 'income', refId: byAmount.id }
    if (haystack.includes('belastingdienst')) {
      const tax = context.incomes.find((income) => income.name.toLowerCase().includes('belasting'))
      return { kind: 'income', refId: tax?.id ?? null }
    }
    return { kind: null, refId: null }
  }

  const paid = -transaction.amountCents
  for (const cost of context.costs) {
    if (!activeOn(cost, transaction.date)) continue
    const close = Math.abs(paid - cost.amountCents) <= Math.max(100, cost.amountCents * 0.02)
    if (close && nearDay(transaction.date, cost.day)) return { kind: 'cost', refId: cost.id }
  }
  const milestone = dueMilestone(context, transaction, true)
  if (milestone) return { kind: 'milestone', refId: milestone.id }
  if (paid <= BUDGET_LIMIT_CENTS) return { kind: 'spend', refId: null }
  return { kind: null, refId: null }
}

/** A rule from a transaction you sorted by hand: the counterparty's name, lower case. */
export function ruleFor(transaction: MoneyTransaction): string {
  return (transaction.counterparty || transaction.description).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 40)
}
