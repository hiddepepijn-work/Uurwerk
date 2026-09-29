/**
 * The bank link, on the machine that holds the Enable Banking key (the laptop).
 *
 * The key, the application id and the session live in the host's secret store (DPAPI on the
 * laptop), never in the database and never on the server. What comes back — balances and
 * transactions — goes into the `_geld_*` tables, and from there to the phone through the
 * encrypted vault like any other Geld row.
 *
 * PSD2 lets a bank refuse more than four reads a day without you present. The background timer
 * therefore reads at most every six hours; opening Geld reads now (at most every five minutes).
 */

import type { MoneyBankStatus } from '@core/contract/types.js'
import { EnableBanking } from '@core/money/bank/enable.js'
import { mapAccount, mapTransaction, pickBalance, toCents } from '@core/money/bank/map.js'
import { addDays } from '@core/money/dates.js'
import { toIsoDate } from '@core/util/time.js'

import type { Backend } from './create.js'
import { emitEvent, host } from './host.js'
import { log } from './log.js'

const BACKGROUND_EVERY_MS = 6 * 3600_000
const PRESENT_EVERY_MS = 5 * 60_000
const FIRST_DAYS = 120
const OVERLAP_DAYS = 10
/** ABN AMRO allows 180 days; asking for a little less leaves room for clocks. */
const CONSENT_DAYS = 179
const DEFAULT_SERVER = 'https://uurwerk.duckdns.org'

export class BankLink {
  private running: Promise<void> | null = null

  constructor(private readonly backend: Backend) {}

  private state(key: string): string | null {
    return this.backend.store.db.get<{ v: string }>('SELECT v FROM _geld_sync_state WHERE k = ?', [`bank.${key}`])?.v ?? null
  }

  private setState(key: string, value: string | null): void {
    if (value === null) this.backend.store.db.run('DELETE FROM _geld_sync_state WHERE k = ?', [`bank.${key}`])
    else this.backend.store.db.run('INSERT OR REPLACE INTO _geld_sync_state (k, v) VALUES (?, ?)', [`bank.${key}`, value])
  }

  private client(): EnableBanking | null {
    const applicationId = host().secrets.get('bankApp')
    const privateKeyPem = host().secrets.get('bankKey')
    return applicationId && privateKeyPem ? new EnableBanking({ applicationId, privateKeyPem }) : null
  }

  private redirectUrl(): string {
    return `${(this.backend.store.settings.get().serverUrl || DEFAULT_SERVER).replace(/\/+$/, '')}/geld/bank`
  }

  status(): MoneyBankStatus {
    const lastFetch = this.state('lastFetch')
    return {
      here: true,
      canFetch: this.client() !== null,
      connected: Boolean(host().secrets.get('bankSession')),
      validUntil: this.state('validUntil'),
      lastFetchAt: lastFetch ? Number(lastFetch) : null,
      lastError: this.state('error')
    }
  }

  /** Stores the application and returns the bank's link; you confirm in the ABN AMRO app. */
  async connect(applicationId: string, privateKeyPem: string): Promise<{ url: string }> {
    const id = applicationId.trim()
    if (!/^[0-9a-f-]{20,}$/i.test(id)) throw new Error('Dat lijkt geen Application ID (een lange code met streepjes).')
    const client = new EnableBanking({ applicationId: id, privateKeyPem })
    const state = globalThis.crypto.randomUUID()
    const validUntil = new Date(Date.now() + CONSENT_DAYS * 86_400_000)
    // Signing happens here first: a wrong key fails now, not after the bank.
    const { url } = await client.startAuthorization({ redirectUrl: this.redirectUrl(), state, validUntil })
    host().secrets.set('bankApp', id)
    host().secrets.set('bankKey', privateKeyPem)
    this.setState('authState', state)
    await host().openExternal(url).catch(() => undefined)
    return { url }
  }

  /** The code from the page the bank sent you back to (or that page's whole address). */
  async finish(codeOrUrl: string): Promise<MoneyBankStatus> {
    const client = this.client()
    if (!client) throw new Error('Verbind eerst met je Application ID en sleutel.')
    let code = codeOrUrl.trim()
    if (code.includes('code=')) {
      const params = new URL(code.includes('://') ? code : `https://x/?${code.split('?').pop()}`).searchParams
      const state = params.get('state')
      if (state && this.state('authState') && state !== this.state('authState')) throw new Error('Deze code hoort bij een andere poging. Begin opnieuw.')
      code = params.get('code') ?? ''
    }
    if (!code) throw new Error('Geen code gevonden.')
    const session = await client.createSession(code)
    host().secrets.set('bankSession', session.session_id)
    this.setState('accounts', JSON.stringify(session.accounts.map((account) => account.uid)))
    this.setState('validUntil', session.access?.valid_until ?? new Date(Date.now() + CONSENT_DAYS * 86_400_000).toISOString())
    this.setState('authState', null)
    for (const account of session.accounts) {
      this.backend.store.money.saveAccount({ ...mapAccount(account), balanceCents: null, balanceDate: null })
    }
    await this.fetch(true)
    return this.status()
  }

  async disconnect(): Promise<MoneyBankStatus> {
    const session = host().secrets.get('bankSession')
    const client = this.client()
    if (session && client) await client.endSession(session).catch(() => undefined)
    host().secrets.set('bankSession', '')
    this.setState('accounts', null)
    this.setState('error', null)
    return this.status()
  }

  /** Reads balances and transactions, if the pace allows. `present`: you are looking. */
  fetch(present: boolean): Promise<void> {
    this.running ??= this.read(present).finally(() => {
      this.running = null
    })
    return this.running
  }

  private async read(present: boolean): Promise<void> {
    const client = this.client()
    if (!client || !host().secrets.get('bankSession')) return
    const last = Number(this.state('lastFetch') ?? '0')
    if (Date.now() - last < (present ? PRESENT_EVERY_MS : BACKGROUND_EVERY_MS)) return
    const uids = JSON.parse(this.state('accounts') ?? '[]') as string[]
    const today = toIsoDate(Date.now())
    const from = last > 0 ? addDays(toIsoDate(last), -OVERLAP_DAYS) : addDays(today, -FIRST_DAYS)
    const who = present ? { userAgent: 'Uurwerk (laptop)' } : undefined
    const money = this.backend.store.money
    const before = new Set(money.state().transactions.filter((transaction) => transaction.kind === 'borrowed').map((transaction) => transaction.id))

    try {
      for (const uid of uids) {
        const account = money.state().accounts.find((item) => item.uid === uid)
        const balance = pickBalance((await client.balances(uid, who)).balances)
        if (account && balance) {
          money.saveAccount({ ...account, balanceCents: toCents(balance.balance_amount.amount), balanceDate: balance.reference_date ?? today })
        }
        const transactions = await client.transactions(uid, from, who)
        money.storeTransactions(uid, transactions.map((transaction) => mapTransaction(uid, transaction)).filter((transaction) => transaction.date))
      }
      this.setState('lastFetch', String(Date.now()))
      this.setState('error', null)

      const borrowed = money.state().transactions.filter((transaction) => transaction.kind === 'borrowed' && !before.has(transaction.id))
      for (const transaction of borrowed) {
        emitEvent('notify', {
          level: 'warn',
          message: `€${(Math.abs(transaction.amountCents) / 100).toFixed(2).replace('.', ',')} van je reispot gehaald. Dat is geen geplande boeking; hij komt bij de afsluiting terug.`
        })
      }
      emitEvent('data:invalidated', { domain: 'money' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const expired = /\b(401|403)\b|expired|verlopen/i.test(message)
      this.setState('error', expired ? 'De bankkoppeling is verlopen of ingetrokken. Verbind opnieuw.' : message)
      log.info('Bank read did not complete.', message)
      emitEvent('data:invalidated', { domain: 'money' })
    }
  }
}
