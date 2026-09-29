/**
 * What comes and goes every month, found in the bank history, set against the plan.
 *
 * The plan was typed in from memory; the bank knows better. For each counterparty that shows up
 * in at least two different months with a steady amount, this proposes: it matches a planned
 * cost or income (and says when day or amount differ), or it is new. Planned items the bank
 * never shows are listed too — perhaps paid from another account, perhaps no longer running.
 *
 * Card payments are left out: a supermarket every month is groceries, not a subscription.
 */

import type { IsoDate, MoneyCost, MoneyIncome, MoneyState } from '../../contract/types.js'
import { addDays, monthOf } from '../dates.js'

export interface Recurring {
  key: string
  name: string
  direction: 'in' | 'out'
  amountCents: number
  day: number
  months: number
  lastDate: IsoDate
  /** The latest transaction: sorting it with 'remember' turns the whole group. */
  lastId: string
  /** The plan item it belongs to, if any. */
  match: { type: 'cost'; item: MoneyCost } | { type: 'income'; item: MoneyIncome } | null
  /** The plan says something else: what to change. */
  differs: { day?: number; amountCents?: number } | null
}

export interface PlanCheck {
  recurring: Recurring[]
  /** Planned but not seen in the bank in the window. */
  missing: Array<{ type: 'cost' | 'income'; id: string; name: string }>
  fromDate: IsoDate
}

const CARD = /^(BEA|GEA|eCom|CCV)\s*,/i

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

export function checkPlan(state: MoneyState, today: IsoDate, days = 120): PlanCheck {
  const fromDate = addDays(today, -days)
  const holders = new Set(state.accounts.map((account) => account.name.toLowerCase()))
  const groups = new Map<string, MoneyState['transactions']>()
  for (const transaction of state.transactions) {
    if (transaction.date < fromDate || transaction.pending || CARD.test(transaction.description)) continue
    if (holders.has(transaction.counterparty.toLowerCase()) || /tikkie/i.test(`${transaction.counterparty} ${transaction.description}`)) continue
    if (transaction.kind === 'transfer' || transaction.kind === 'saving' || transaction.kind === 'borrowed' || transaction.kind === 'milestone') continue
    const key = `${transaction.counterparty.toLowerCase()}|${transaction.amountCents > 0 ? 'in' : 'out'}`
    groups.set(key, [...(groups.get(key) ?? []), transaction])
  }

  const recurring: Recurring[] = []
  for (const [key, list] of groups) {
    const months = new Set(list.map((transaction) => monthOf(transaction.date))).size
    if (months < 2) continue
    const amounts = list.map((transaction) => Math.abs(transaction.amountCents))
    const amountCents = median(amounts)
    // Steady: most payments within 15% of the usual amount (a salary within 30%).
    const incoming = list[0]!.amountCents > 0
    const spread = incoming ? 0.3 : 0.15
    const steady = amounts.filter((amount) => Math.abs(amount - amountCents) <= amountCents * spread).length >= Math.ceil(list.length * 0.6)
    // Many small payments a month (PayPal, say) are purchases, not one bill.
    if (!steady || list.length > months * 2) continue
    const day = median(list.map((transaction) => Number(transaction.date.slice(8, 10))))
    const latest = [...list].sort((a, b) => b.date.localeCompare(a.date))[0]!
    const lastDate = latest.date

    // The plan item most of this group was sorted to; one lucky amount is not a match.
    const votes = new Map<string, number>()
    for (const transaction of list) {
      if (transaction.refId && (transaction.kind === 'cost' || transaction.kind === 'income')) {
        votes.set(`${transaction.kind}|${transaction.refId}`, (votes.get(`${transaction.kind}|${transaction.refId}`) ?? 0) + 1)
      }
    }
    const [winner, count] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0]
    const linked = winner && count * 2 >= list.length ? { kind: winner.split('|')[0], refId: winner.split('|')[1] } : null
    let match: Recurring['match'] = null
    if (linked?.kind === 'cost') {
      const item = state.costs.find((cost) => cost.id === linked.refId)
      if (item) match = { type: 'cost', item }
    } else if (linked?.kind === 'income') {
      const item = state.incomes.find((income) => income.id === linked.refId)
      if (item) match = { type: 'income', item }
    }
    let differs: Recurring['differs'] = null
    if (match) {
      const plannedDay = match.type === 'cost' ? match.item.day : match.item.day ?? day
      const plannedAmount = match.type === 'cost' ? match.item.amountCents : match.item.amountCents ?? amountCents
      const change: NonNullable<Recurring['differs']> = {}
      if (Math.abs(plannedDay - day) > 2) change.day = day
      if (Math.abs(plannedAmount - amountCents) > Math.max(100, plannedAmount * 0.03)) change.amountCents = amountCents
      if (change.day !== undefined || change.amountCents !== undefined) differs = change
    }
    recurring.push({ key, name: list[0]!.counterparty, direction: incoming ? 'in' : 'out', amountCents, day, months, lastDate, lastId: latest.id, match, differs })
  }

  const seenCosts = new Set(recurring.filter((item) => item.match?.type === 'cost').map((item) => item.match!.item.id))
  const seenIncomes = new Set(recurring.filter((item) => item.match?.type === 'income').map((item) => item.match!.item.id))
  // Also count single matches: a cost paid once in the window was still seen.
  for (const transaction of state.transactions) {
    if (transaction.date < fromDate || !transaction.refId) continue
    if (transaction.kind === 'cost') seenCosts.add(transaction.refId)
    if (transaction.kind === 'income') seenIncomes.add(transaction.refId)
  }
  const missing: PlanCheck['missing'] = [
    ...state.costs
      .filter((cost) => !seenCosts.has(cost.id) && (cost.until === null || cost.until >= fromDate))
      .map((cost) => ({ type: 'cost' as const, id: cost.id, name: cost.name })),
    ...state.incomes
      .filter((income) => income.kind === 'fixed' && !seenIncomes.has(income.id) && (income.until === null || income.until >= fromDate))
      .map((income) => ({ type: 'income' as const, id: income.id, name: income.name }))
  ]

  return {
    recurring: recurring.sort((a, b) => Number(a.match !== null) - Number(b.match !== null) || b.amountCents - a.amountCents),
    missing,
    fromDate
  }
}
