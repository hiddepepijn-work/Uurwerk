import type {
  IsoDate,
  MoneyAccount,
  MoneyRule,
  MoneyTransaction,
  MoneyTransactionKind,
  IsoMonth,
  MoneyClosing,
  MoneyCost,
  MoneyEntry,
  MoneyGoal,
  MoneyIncome,
  MoneyMilestone,
  MoneyPhase,
  MoneyShift,
  MoneyState,
  NewMoneyEntry,
  PayProfile
} from '../../contract/types.js'
import { classify, ruleFor } from '../../money/bank/classify.js'
import { merchantName } from '../../money/bank/map.js'
import { addMonths, firstOfMonth } from '../../money/dates.js'
import { ensureMoneySchema } from '../../money/schema.js'
import { STARTER } from '../../money/starter.js'
import { closingProposal, type ClosingProposal } from '../../money/status.js'
import { Db, newId } from '../connection.js'

/** Optional id: without one, save() adds; with one, it replaces. */
type Draft<T extends { id: string }> = Omit<T, 'id'> & { id?: string }

interface IncomeRow {
  id: string
  name: string
  kind: MoneyIncome['kind']
  amount_cents: number | null
  day: number | null
  from_date: string | null
  until_date: string | null
}
interface CostRow {
  id: string
  name: string
  category: string
  amount_cents: number
  day: number
  from_date: string | null
  until_date: string | null
}
interface PhaseRow {
  id: string
  name: string
  from_date: string
  until_date: string
  budget_cents: number
  saving_cents: number | null
}
interface GoalRow {
  id: string
  name: string
  on_account_cents: number
  start_cents: number
  date: string
}
interface MilestoneRow {
  id: string
  name: string
  date: string
  amount_cents: number
  paid: number
}
interface EntryRow {
  id: string
  date: string
  kind: MoneyEntry['kind']
  amount_cents: number
  note: string
  category: string | null
  created_at: number
}
interface ShiftRow {
  id: string
  date: string
  template: string
  status: MoneyShift['status']
}
interface AccountRow {
  uid: string
  iban: string
  name: string
  role: MoneyAccount['role']
  locked_until: string | null
  balance_cents: number | null
  balance_date: string | null
}
interface TransactionRow {
  id: string
  account_uid: string
  date: string
  amount_cents: number
  counterparty: string
  counter_iban: string | null
  description: string
  pending: number
  kind: MoneyTransactionKind | null
  ref_id: string | null
  manual: number
}
interface RuleRow {
  id: string
  pattern: string
  kind: MoneyTransactionKind
  ref_id: string | null
}
interface ClosingRow {
  month: string
  saving_cents: number
  from_extra_cents: number
  extra_cents: number
  budget_left_cents: number
  closed_at: number
}

const mapTransactionRow = (row: TransactionRow): MoneyTransaction => ({
  id: row.id,
  accountUid: row.account_uid,
  date: row.date,
  amountCents: row.amount_cents,
  counterparty: row.counterparty,
  counterIban: row.counter_iban,
  description: row.description,
  pending: row.pending === 1,
  kind: row.kind,
  refId: row.ref_id,
  manual: row.manual === 1
})

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function checkCents(value: number, what: string): void {
  if (!Number.isInteger(value)) throw new Error(`${what}: bedrag moet in hele centen.`)
}

function checkDate(value: string | null, what: string): void {
  if (value !== null && !ISO_DATE.test(value)) throw new Error(`${what}: datum moet JJJJ-MM-DD zijn.`)
}

/**
 * Geld: everything in the `_geld_*` tables (money/schema.ts). Local to this copy — the sync
 * never sees these tables, and the pairing snapshot has them wiped before it leaves.
 */
export class MoneyRepo {
  constructor(private readonly db: Db) {
    ensureMoneySchema(db)
    this.repairShopNames()
  }

  /**
   * Card payments fetched before shop names were read from the text still say "POS NATIONAL".
   * Cheap to check on every open: only those rows are touched, once.
   */
  private repairShopNames(): void {
    const rows = this.db.all<{ id: string; counterparty: string; description: string }>(
      "SELECT id, counterparty, description FROM _geld_transactions WHERE counterparty IN ('POS NATIONAL', 'POS INTERNATIONAL')"
    )
    if (rows.length === 0) return
    this.db.transaction(() => {
      for (const row of rows) {
        this.db.run('UPDATE _geld_transactions SET counterparty = ?, updated_at = ? WHERE id = ?', [merchantName(row.counterparty, row.description), Date.now(), row.id])
      }
    })
    this.reclassify()
  }

  state(): MoneyState {
    const profileRow = this.db.get<{ data: string }>('SELECT data FROM _geld_profiles ORDER BY updated_at DESC LIMIT 1')
    const goalRow = this.db.get<GoalRow>('SELECT * FROM _geld_goals ORDER BY updated_at DESC LIMIT 1')
    return {
      accounts: this.db.all<AccountRow>('SELECT * FROM _geld_accounts ORDER BY role, name').map((row) => ({
        uid: row.uid,
        iban: row.iban,
        name: row.name,
        role: row.role,
        lockedUntil: row.locked_until,
        balanceCents: row.balance_cents,
        balanceDate: row.balance_date
      })),
      transactions: this.db.all<TransactionRow>('SELECT * FROM _geld_transactions ORDER BY date DESC, id').map(mapTransactionRow),
      rules: this.db.all<RuleRow>('SELECT * FROM _geld_rules ORDER BY pattern').map((row) => ({ id: row.id, pattern: row.pattern, kind: row.kind, refId: row.ref_id })),
      incomes: this.db.all<IncomeRow>('SELECT * FROM _geld_incomes ORDER BY kind, name').map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        amountCents: row.amount_cents,
        day: row.day,
        from: row.from_date,
        until: row.until_date
      })),
      costs: this.db.all<CostRow>('SELECT * FROM _geld_costs ORDER BY category, day, name').map((row) => ({
        id: row.id,
        name: row.name,
        category: row.category,
        amountCents: row.amount_cents,
        day: row.day,
        from: row.from_date,
        until: row.until_date
      })),
      phases: this.db.all<PhaseRow>('SELECT * FROM _geld_phases ORDER BY from_date').map((row) => ({
        id: row.id,
        name: row.name,
        from: row.from_date,
        until: row.until_date,
        budgetCents: row.budget_cents,
        savingCents: row.saving_cents
      })),
      goal: goalRow
        ? {
            id: goalRow.id,
            name: goalRow.name,
            onAccountCents: goalRow.on_account_cents,
            startCents: goalRow.start_cents,
            date: goalRow.date
          }
        : null,
      milestones: this.db.all<MilestoneRow>('SELECT * FROM _geld_milestones ORDER BY date').map((row) => ({
        id: row.id,
        name: row.name,
        date: row.date,
        amountCents: row.amount_cents,
        paid: row.paid === 1
      })),
      entries: this.db.all<EntryRow>('SELECT * FROM _geld_entries ORDER BY date DESC, created_at DESC').map((row) => ({
        id: row.id,
        date: row.date,
        kind: row.kind,
        amountCents: row.amount_cents,
        note: row.note,
        category: row.category,
        createdAt: row.created_at
      })),
      shifts: this.db.all<ShiftRow>('SELECT * FROM _geld_shifts ORDER BY date').map((row) => ({
        id: row.id,
        date: row.date,
        template: row.template,
        status: row.status
      })),
      profile: profileRow ? (JSON.parse(profileRow.data) as PayProfile) : null,
      closings: this.db.all<ClosingRow>('SELECT * FROM _geld_closings ORDER BY month').map((row) => ({
        month: row.month,
        savingCents: row.saving_cents,
        fromExtraCents: row.from_extra_cents,
        extraCents: row.extra_cents,
        budgetLeftCents: row.budget_left_cents,
        closedAt: row.closed_at
      }))
    }
  }

  isEmpty(): boolean {
    const phases = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM _geld_phases')?.n ?? 0
    const goals = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM _geld_goals')?.n ?? 0
    return phases === 0 && goals === 0
  }

  /** Fills in the agreed starting plan — only on an empty Geld, so it never overwrites. */
  loadStarter(): MoneyState {
    if (!this.isEmpty()) throw new Error('Geld is al ingevuld; het startplan overschrijft niets.')
    this.db.transaction(() => {
      for (const phase of STARTER.phases) this.savePhase(phase)
      for (const income of STARTER.incomes) this.saveIncome(income)
      for (const cost of STARTER.costs) this.saveCost(cost)
      if (STARTER.goal) this.saveGoal(STARTER.goal)
      for (const milestone of STARTER.milestones) this.saveMilestone(milestone)
      if (STARTER.profile) this.saveProfile(STARTER.profile)
    })
    return this.state()
  }

  // ---------------------------------------------------------------- plan pieces

  saveIncome(input: Draft<MoneyIncome>): MoneyIncome {
    const name = input.name.trim()
    if (!name) throw new Error('Een inkomen heeft een naam nodig.')
    if (input.amountCents !== null) checkCents(input.amountCents, name)
    checkDate(input.from, name)
    checkDate(input.until, name)
    const id = input.id ?? newId()
    this.db.run(
      `INSERT INTO _geld_incomes (id, name, kind, amount_cents, day, from_date, until_date, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, amount_cents = excluded.amount_cents,
         day = excluded.day, from_date = excluded.from_date, until_date = excluded.until_date, updated_at = excluded.updated_at`,
      [id, name, input.kind, input.amountCents, input.day, input.from, input.until, Date.now()]
    )
    this.reclassify()
    return { ...input, id, name }
  }

  removeIncome(id: string): void {
    this.db.run('DELETE FROM _geld_incomes WHERE id = ?', [id])
    this.reclassify()
  }

  saveCost(input: Draft<MoneyCost>): MoneyCost {
    const name = input.name.trim()
    if (!name) throw new Error('Een vaste last heeft een naam nodig.')
    checkCents(input.amountCents, name)
    if (input.day < 1 || input.day > 31) throw new Error(`${name}: dag moet tussen 1 en 31 liggen.`)
    checkDate(input.from, name)
    checkDate(input.until, name)
    const id = input.id ?? newId()
    const category = input.category.trim() || 'Overig'
    this.db.run(
      `INSERT INTO _geld_costs (id, name, category, amount_cents, day, from_date, until_date, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, category = excluded.category, amount_cents = excluded.amount_cents,
         day = excluded.day, from_date = excluded.from_date, until_date = excluded.until_date, updated_at = excluded.updated_at`,
      [id, name, category, input.amountCents, input.day, input.from, input.until, Date.now()]
    )
    this.reclassify()
    return { ...input, id, name, category }
  }

  removeCost(id: string): void {
    this.db.run('DELETE FROM _geld_costs WHERE id = ?', [id])
    this.reclassify()
  }

  savePhase(input: Draft<MoneyPhase>): MoneyPhase {
    const name = input.name.trim()
    if (!name) throw new Error('Een fase heeft een naam nodig.')
    checkDate(input.from, name)
    checkDate(input.until, name)
    if (input.until < input.from) throw new Error(`${name}: eind ligt vóór begin.`)
    checkCents(input.budgetCents, name)
    if (input.savingCents !== null) checkCents(input.savingCents, name)
    const id = input.id ?? newId()
    this.db.run(
      `INSERT INTO _geld_phases (id, name, from_date, until_date, budget_cents, saving_cents, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, from_date = excluded.from_date, until_date = excluded.until_date,
         budget_cents = excluded.budget_cents, saving_cents = excluded.saving_cents, updated_at = excluded.updated_at`,
      [id, name, input.from, input.until, input.budgetCents, input.savingCents, Date.now()]
    )
    return { ...input, id, name }
  }

  removePhase(id: string): void {
    this.db.run('DELETE FROM _geld_phases WHERE id = ?', [id])
  }

  /** One goal at a time: saving another replaces it. */
  saveGoal(input: Draft<MoneyGoal>): MoneyGoal {
    const name = input.name.trim() || 'Doel'
    checkDate(input.date, name)
    checkCents(input.onAccountCents, name)
    checkCents(input.startCents, name)
    const id = input.id ?? newId()
    this.db.transaction(() => {
      this.db.run('DELETE FROM _geld_goals WHERE id <> ?', [id])
      this.db.run(
        `INSERT INTO _geld_goals (id, name, on_account_cents, start_cents, date, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, on_account_cents = excluded.on_account_cents,
           start_cents = excluded.start_cents, date = excluded.date, updated_at = excluded.updated_at`,
        [id, name, input.onAccountCents, input.startCents, input.date, Date.now()]
      )
    })
    return { ...input, id, name }
  }

  saveMilestone(input: Draft<MoneyMilestone>): MoneyMilestone {
    const name = input.name.trim()
    if (!name) throw new Error('Een mijlpaal heeft een naam nodig.')
    checkDate(input.date, name)
    checkCents(input.amountCents, name)
    const id = input.id ?? newId()
    this.db.run(
      `INSERT INTO _geld_milestones (id, name, date, amount_cents, paid, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, date = excluded.date, amount_cents = excluded.amount_cents,
         paid = excluded.paid, updated_at = excluded.updated_at`,
      [id, name, input.date, input.amountCents, input.paid ? 1 : 0, Date.now()]
    )
    return { ...input, id, name }
  }

  removeMilestone(id: string): void {
    this.db.run('DELETE FROM _geld_milestones WHERE id = ?', [id])
  }

  saveProfile(profile: PayProfile): PayProfile {
    if (!Number.isFinite(profile.netFactor) || profile.netFactor <= 0 || profile.netFactor > 1) {
      throw new Error('Nettofactor moet tussen 0 en 1 liggen.')
    }
    checkCents(profile.hourlyCents, 'Uurloon')
    this.db.run(
      `INSERT INTO _geld_profiles (id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      [profile.id, JSON.stringify(profile), Date.now()]
    )
    return profile
  }

  // ---------------------------------------------------------------- what happened

  addEntry(input: NewMoneyEntry): MoneyEntry {
    checkDate(input.date, 'Boeking')
    checkCents(input.amountCents, 'Boeking')
    if (input.kind === 'spend' && input.amountCents <= 0) throw new Error('Een uitgave is meer dan €0.')
    const id = newId()
    const now = Date.now()
    this.db.run(
      `INSERT INTO _geld_entries (id, date, kind, amount_cents, note, category, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.date, input.kind, input.amountCents, input.note.trim(), input.category, now, now]
    )
    return { ...input, note: input.note.trim(), id, createdAt: now }
  }

  removeEntry(id: string): void {
    this.db.run('DELETE FROM _geld_entries WHERE id = ?', [id])
  }

  saveShift(input: Draft<MoneyShift>): MoneyShift {
    checkDate(input.date, 'Dienst')
    const id = input.id ?? newId()
    this.db.run(
      `INSERT INTO _geld_shifts (id, date, template, status, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET date = excluded.date, template = excluded.template, status = excluded.status,
         updated_at = excluded.updated_at`,
      [id, input.date, input.template, input.status, Date.now()]
    )
    return { ...input, id }
  }

  removeShift(id: string): void {
    this.db.run('DELETE FROM _geld_shifts WHERE id = ?', [id])
  }

  // ---------------------------------------------------------------- the bank

  /** An account as the bank reports it. Role and lock are yours: a refresh never overwrites them. */
  saveAccount(account: Omit<MoneyAccount, 'lockedUntil'> & { lockedUntil?: IsoDate | null }): void {
    const existing = this.db.get<AccountRow>('SELECT * FROM _geld_accounts WHERE uid = ?', [account.uid])
    this.db.run(
      `INSERT OR REPLACE INTO _geld_accounts (uid, iban, name, role, locked_until, balance_cents, balance_date, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        account.uid,
        account.iban,
        account.name,
        existing?.role ?? account.role,
        account.lockedUntil !== undefined ? account.lockedUntil : existing?.locked_until ?? null,
        account.balanceCents ?? existing?.balance_cents ?? null,
        account.balanceDate ?? existing?.balance_date ?? null,
        Date.now()
      ]
    )
  }

  /**
   * A savings account the bank does not share (ABN AMRO: PSD2 covers current accounts only).
   * Its balance on a date; transfers to and from it on the current account carry it forward.
   */
  saveManualSavings(input: { iban: string; name: string; balanceCents: number; date: IsoDate; lockedUntil: IsoDate | null }): void {
    const iban = input.iban.replace(/\s+/g, '').toUpperCase()
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(iban)) throw new Error('Dat is geen IBAN.')
    checkCents(input.balanceCents, 'Saldo')
    checkDate(input.date, 'Saldo')
    checkDate(input.lockedUntil, 'Slot')
    this.db.transaction(() => {
      this.db.run('DELETE FROM _geld_accounts WHERE uid LIKE ? AND uid <> ?', ['manual:%', `manual:${iban}`])
      this.db.run(
        `INSERT OR REPLACE INTO _geld_accounts (uid, iban, name, role, locked_until, balance_cents, balance_date, updated_at)
         VALUES (?, ?, ?, 'spaar', ?, ?, ?, ?)`,
        [`manual:${iban}`, iban, input.name.trim() || 'Spaarrekening', input.lockedUntil, input.balanceCents, input.date, Date.now()]
      )
      this.reclassify()
    })
  }

  setAccountRole(uid: string, role: MoneyAccount['role'], lockedUntil: IsoDate | null): void {
    checkDate(lockedUntil, 'Slot')
    this.db.run('UPDATE _geld_accounts SET role = ?, locked_until = ?, updated_at = ? WHERE uid = ?', [role, lockedUntil, Date.now(), uid])
    this.reclassify()
  }

  /**
   * What a fetch brought in. Pending transactions are replaced every time (they change id
   * once booked); booked ones keep how you sorted them. Returns the ids that are new.
   */
  storeTransactions(accountUid: string, transactions: MoneyTransaction[]): string[] {
    const fresh: string[] = []
    this.db.transaction(() => {
      this.db.run('DELETE FROM _geld_transactions WHERE account_uid = ? AND pending = 1', [accountUid])
      const now = Date.now()
      for (const transaction of transactions) {
        const existing = this.db.get<TransactionRow>('SELECT * FROM _geld_transactions WHERE id = ?', [transaction.id])
        if (!existing) fresh.push(transaction.id)
        if (
          existing &&
          existing.date === transaction.date &&
          existing.amount_cents === transaction.amountCents &&
          existing.pending === (transaction.pending ? 1 : 0) &&
          existing.counterparty === transaction.counterparty
        ) {
          continue
        }
        this.db.run(
          `INSERT OR REPLACE INTO _geld_transactions
             (id, account_uid, date, amount_cents, counterparty, counter_iban, description, pending, kind, ref_id, manual, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            transaction.id,
            accountUid,
            transaction.date,
            transaction.amountCents,
            transaction.counterparty,
            transaction.counterIban,
            transaction.description,
            transaction.pending ? 1 : 0,
            existing?.kind ?? null,
            existing?.ref_id ?? null,
            existing?.manual ?? 0,
            now
          ]
        )
      }
      this.reclassify()
    })
    return fresh
  }

  /** Sorts every transaction you did not sort by hand, with the current plan and rules. */
  reclassify(): number {
    if ((this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM _geld_transactions')?.n ?? 0) === 0) return 0
    const state = this.state()
    let changed = 0
    // Oldest first, each seeing how the ones before it were sorted: the first withdrawal for a
    // flight claims it, a later one does not.
    const ordered = [...state.transactions].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
    const context = { ...state, transactions: ordered }
    this.db.transaction(() => {
      for (const transaction of ordered) {
        if (transaction.manual) continue
        const result = classify(transaction, context)
        if (result.kind === transaction.kind && result.refId === transaction.refId) continue
        transaction.kind = result.kind
        transaction.refId = result.refId
        this.db.run('UPDATE _geld_transactions SET kind = ?, ref_id = ?, updated_at = ? WHERE id = ?', [result.kind, result.refId, Date.now(), transaction.id])
        changed += 1
      }
    })
    return changed
  }

  /** You sorted one. With `remember`, everything from the same counterparty goes the same way. */
  sortTransaction(id: string, kind: MoneyTransactionKind | null, refId: string | null, remember: boolean): void {
    const row = this.db.get<TransactionRow>('SELECT * FROM _geld_transactions WHERE id = ?', [id])
    if (!row) throw new Error('Die transactie bestaat niet.')
    this.db.transaction(() => {
      this.db.run('UPDATE _geld_transactions SET kind = ?, ref_id = ?, manual = ?, updated_at = ? WHERE id = ?', [kind, refId, kind === null ? 0 : 1, Date.now(), id])
      const pattern = ruleFor(mapTransactionRow(row))
      if (remember && kind && pattern) {
        this.db.run('DELETE FROM _geld_rules WHERE pattern = ?', [pattern])
        this.db.run('INSERT INTO _geld_rules (id, pattern, kind, ref_id, updated_at) VALUES (?, ?, ?, ?, ?)', [newId(), pattern, kind, refId, Date.now()])
        this.reclassify()
      }
    })
  }

  removeRule(id: string): MoneyRule[] {
    this.db.run('DELETE FROM _geld_rules WHERE id = ?', [id])
    this.reclassify()
    return this.state().rules
  }

  // ---------------------------------------------------------------- month closing

  proposal(month: IsoMonth): ClosingProposal {
    return closingProposal(this.state(), month)
  }

  /**
   * Closes `month` as proposed: the saving into the pot, what Extra adds or receives, and the
   * record that stops the projection from counting the month again. Dated the first of the
   * next month, when the transfers are made.
   */
  close(month: IsoMonth, today: IsoDate): MoneyClosing {
    if (this.db.get('SELECT month FROM _geld_closings WHERE month = ?', [month])) {
      throw new Error(`${month} is al afgesloten.`)
    }
    const proposal = this.proposal(month)
    const date = today < firstOfMonth(addMonths(month, 1)) ? today : firstOfMonth(addMonths(month, 1))
    const closedAt = Date.now()
    this.db.transaction(() => {
      const saving = proposal.savingCents + proposal.fromExtraCents
      if (saving > 0) this.addEntry({ date, kind: 'saving', amountCents: saving, note: `Afsluiting ${month}`, category: null })
      const toExtra = proposal.extraCents + proposal.budgetLeftCents - proposal.fromExtraCents
      if (toExtra !== 0) this.addEntry({ date, kind: 'extra', amountCents: toExtra, note: `Afsluiting ${month}`, category: null })
      this.db.run(
        `INSERT INTO _geld_closings (month, saving_cents, from_extra_cents, extra_cents, budget_left_cents, closed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [month, proposal.savingCents, proposal.fromExtraCents, proposal.extraCents, proposal.budgetLeftCents, closedAt]
      )
    })
    return {
      month,
      savingCents: proposal.savingCents,
      fromExtraCents: proposal.fromExtraCents,
      extraCents: proposal.extraCents,
      budgetLeftCents: proposal.budgetLeftCents,
      closedAt
    }
  }

  /** Takes a closing back, with the entries it made. */
  reopen(month: IsoMonth): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM _geld_entries WHERE note = ? AND kind IN (?, ?)', [`Afsluiting ${month}`, 'saving', 'extra'])
      this.db.run('DELETE FROM _geld_closings WHERE month = ?', [month])
    })
  }
}
