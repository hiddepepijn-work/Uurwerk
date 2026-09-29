import { describe, expect, it } from 'vitest'

import type { MoneyState } from '../contract/types.js'
import { openStore } from '../db/index.js'
import { syncedTables } from '../sync/schema.js'
import { addMonths, dayInMonth, weekdaysInMonth } from './dates.js'
import { shiftPay, templateFor } from './pay.js'
import { monthPlan, weeklyPayments } from './plan.js'
import { project } from './projection.js'
import { ADECCO_PROFILE, STARTER } from './starter.js'
import { budgetStatus, closingProposal, goalStatus } from './status.js'

// The plan as first calculated: starting €300 in the red, which the numbers below were worked out with.
const starterState = (): MoneyState => ({ ...STARTER, goal: { ...STARTER.goal!, startCents: -30000 }, entries: [], shifts: [], closings: [], accounts: [], transactions: [], rules: [] })

const pay = (key: string) => shiftPay(ADECCO_PROFILE, templateFor(ADECCO_PROFILE, key)!)

describe('Geld: dates', () => {
  it('clamps a day to the month and steps across years', () => {
    expect(dayInMonth('2026-11', 31)).toBe('2026-11-30')
    expect(dayInMonth('2027-02', 30)).toBe('2027-02-28')
    expect(addMonths('2026-12', 1)).toBe('2027-01')
    expect(addMonths('2027-01', -1)).toBe('2026-12')
  })

  it('finds the Thursdays of a month', () => {
    expect(weekdaysInMonth('2026-10', 4)).toEqual(['2026-10-01', '2026-10-08', '2026-10-15', '2026-10-22', '2026-10-29'])
  })
})

describe('Geld: what a shift earns', () => {
  it('pays the evening shift 7h50 with two hours at +20%', () => {
    const avond = pay('avond')
    expect(avond.paidMinutes).toBe(470)
    expect(avond.minutesByPercent).toEqual({ 0: 350, 20: 120 })
    expect(avond.grossCents).toBe(12918)
  })

  it('pays the late shift across midnight in two premium windows', () => {
    const laat = pay('laat')
    expect(laat.paidMinutes).toBe(410)
    expect(laat.minutesByPercent).toEqual({ 0: 170, 20: 180, 30: 60 })
    expect(laat.grossCents).toBe(12134)
  })

  it('takes the night break out of the +30% window', () => {
    const nacht = pay('nacht')
    expect(nacht.paidMinutes).toBe(430)
    expect(nacht.minutesByPercent).toEqual({ 0: 60, 20: 60, 30: 310 })
    expect(nacht.grossCents).toBe(13990)
  })

  it('adds 16 km of travel, untaxed, to the net', () => {
    const nacht = pay('nacht')
    expect(nacht.travelCents).toBe(368)
    expect(nacht.netCents).toBe(12591)
    expect(nacht.totalCents).toBe(12959)
  })
})

describe('Geld: the plan per month', () => {
  it('needs €1.061,65 from shifts in the internship months', () => {
    const plan = monthPlan(starterState(), '2026-11')
    expect(plan.fixedIncomeCents).toBe(72900)
    expect(plan.costsCents).toBe(62065)
    expect(plan.budgetCents).toBe(15000)
    expect(plan.savingTargetCents).toBe(102000)
    expect(plan.neededFromShiftsCents).toBe(106165)
    expect(plan.shiftsNeeded).toBe(9)
  })

  it('drops the school fees and the shifts in February', () => {
    const plan = monthPlan(starterState(), '2027-02')
    expect(plan.costsCents).toBe(29729)
    expect(plan.hasShifts).toBe(false)
    expect(plan.savingTargetCents).toBeNull()
  })

  it('pays full-time Adecco weekly, a week late', () => {
    const february = weeklyPayments(STARTER.incomes, '2027-02')
    // 4 Feb pays 25–31 Jan, before the job starts.
    expect(february.map((payment) => payment.date)).toEqual(['2027-02-11', '2027-02-18', '2027-02-25'])
    expect(february[0]!.amountCents).toBe(51923)
    // Only 1 April lands before departure on the 7th.
    expect(weeklyPayments(STARTER.incomes, '2027-04', '2027-04-07').map((payment) => payment.date)).toEqual(['2027-04-01'])
  })
})

describe('Geld: the trip projection', () => {
  it('reaches €5.400 on the account with nine nights a month, not with eight', () => {
    const state = starterState()
    const nine = project(state, { today: '2026-09-29', shiftsPerMonth: 9 })!
    const eight = project(state, { today: '2026-09-29', shiftsPerMonth: 8 })!
    expect(nine.targetSavedCents).toBe(730000)
    expect(nine.months.slice(0, 4).map((month) => month.savingCents)).toEqual([102000, 102000, 102000, 102000])
    expect(nine.checks.every((check) => check.shortCents === 0)).toBe(true)
    // Within a few euros: fase 2 pays a week late, so the last week falls after departure.
    expect(nine.finalInPotCents).toBeGreaterThan(535000)
    expect(eight.finalInPotCents).toBeLessThan(nine.finalInPotCents)
    expect(eight.shortCents).toBeGreaterThan(0)
  })

  it('counts a paid flight as spent, not as lost progress', () => {
    const state = starterState()
    state.entries.push({ id: 'e1', date: '2026-11-01', kind: 'saving', amountCents: 102000, note: '', category: null, createdAt: 0 })
    state.milestones = state.milestones.map((milestone, index) => (index === 0 ? { ...milestone, paid: true } : milestone))
    const goal = goalStatus(state)!
    expect(goal.savedCents).toBe(72000)
    expect(goal.inPotCents).toBe(-3000)
    expect(goal.targetSavedCents).toBe(730000)
  })
})

describe('Geld: budget and closing', () => {
  it('shows the budget left and the pace on 17 November', () => {
    const state = starterState()
    for (const amount of [1250, 2390, 800, 1400, 590]) {
      state.entries.push({ id: String(amount), date: '2026-11-10', kind: 'spend', amountCents: amount, note: '', category: null, createdAt: 0 })
    }
    const budget = budgetStatus(state, '2026-11-17')
    expect(budget.spentCents).toBe(6430)
    expect(budget.leftCents).toBe(8570)
    expect(budget.daysLeft).toBe(14)
    expect(budget.aheadCents).toBe(8500 - 6430)
  })

  it('takes a November short-fall out of Extra', () => {
    const state = starterState()
    state.entries.push({ id: 'x', date: '2026-11-01', kind: 'extra', amountCents: 10466, note: '', category: null, createdAt: 0 })
    state.entries.push({ id: 'p', date: '2026-11-26', kind: 'shiftPay', amountCents: 103382, note: '', category: null, createdAt: 0 })
    state.entries.push({ id: 's', date: '2026-11-20', kind: 'spend', amountCents: 14210, note: '', category: null, createdAt: 0 })
    const closing = closingProposal(state, '2026-11')
    expect(closing.availableCents).toBe(72900 + 103382 - 62065 - 15000)
    expect(closing.savingCents).toBe(99217)
    expect(closing.fromExtraCents).toBe(2783)
    expect(closing.shortCents).toBe(0)
    expect(closing.budgetLeftCents).toBe(790)
  })
})

describe('Geld in the database', () => {
  it('never gives its tables to the sync', () => {
    const store = openStore(':memory:')
    const names = syncedTables(store.db).map((table) => table.name)
    expect(names.some((name) => name.startsWith('_geld'))).toBe(false)
    expect(names.length).toBeGreaterThan(0)
  })

  it('loads the starting plan once, and refuses a second time', () => {
    const store = openStore(':memory:')
    const state = store.money.loadStarter()
    expect(state.costs).toHaveLength(8)
    expect(state.goal?.onAccountCents).toBe(540000)
    expect(state.profile?.templates.map((template) => template.key)).toEqual(['avond', 'laat', 'nacht'])
    expect(() => store.money.loadStarter()).toThrow()
  })

  it('closes a month into entries and can take it back', () => {
    const store = openStore(':memory:')
    store.money.loadStarter()
    store.money.addEntry({ date: '2026-10-29', kind: 'shiftPay', amountCents: 112466, note: 'Adecco', category: null })
    const closing = store.money.close('2026-10', '2026-11-01')
    expect(closing.savingCents).toBe(102000)
    const state = store.money.state()
    expect(state.entries.filter((entry) => entry.kind === 'saving').map((entry) => entry.amountCents)).toEqual([102000])
    expect(() => store.money.close('2026-10', '2026-11-01')).toThrow()
    store.money.reopen('2026-10')
    expect(store.money.state().closings).toEqual([])
    expect(store.money.state().entries.filter((entry) => entry.kind !== 'shiftPay')).toEqual([])
  })
})

describe('Geld and the pairing snapshot', () => {
  it('leaves no trace of Geld in the copy that goes to the server', async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const { wipeMoneyFromCopy } = await import('./schema.js')
    const dir = mkdtempSync(join(tmpdir(), 'uurwerk-geld-'))
    const file = join(dir, 'snapshot.db')
    try {
      const store = openStore(':memory:')
      store.money.loadStarter()
      store.money.addEntry({ date: '2026-11-10', kind: 'spend', amountCents: 1234, note: 'GEHEIMEFRIETTENT', category: null })
      store.db.exec(`VACUUM INTO '${file.replace(/\\/g, '/')}'`)
      expect(readFileSync(file).includes('GEHEIMEFRIETTENT')).toBe(true)
      wipeMoneyFromCopy(store.db, file)
      expect(readFileSync(file).includes('GEHEIMEFRIETTENT')).toBe(false)
      expect(readFileSync(file).includes('_geld_')).toBe(false)
      // The live copy keeps everything.
      expect(store.money.state().entries).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Geld: what already happened counts', () => {
  it('uses the pay that arrived for a month that is over, not the plan', () => {
    const state = starterState()
    state.entries.push({ id: 'p', date: '2026-10-29', kind: 'shiftPay', amountCents: 76800, note: '', category: null, createdAt: 0 })
    const october = project(state, { today: '2026-11-17', shiftsPerMonth: 9 })!.months[0]!
    expect(october.month).toBe('2026-10')
    expect(october.shiftsCents).toBe(76800)
    expect(october.savingCents).toBe(72900 + 76800 - 62065 - 15000)
  })
})

describe('Geld saves the same thing twice', () => {
  it('lets you edit a goal, a cost and a phase again while the sync queue still holds them', () => {
    const store = openStore(':memory:')
    const state = store.money.loadStarter()
    for (let round = 0; round < 3; round += 1) {
      store.money.saveGoal({ ...state.goal!, startCents: round * 100 })
      store.money.saveCost({ ...state.costs[0]!, day: 10 + round })
      store.money.savePhase({ ...state.phases[0]!, budgetCents: 15000 + round })
    }
    expect(store.money.state().goal?.startCents).toBe(200)
    expect(store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM _geld_outbox WHERE tbl = '_geld_goals'")?.n).toBe(1)
  })
})
