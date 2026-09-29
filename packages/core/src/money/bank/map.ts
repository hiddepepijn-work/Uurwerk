/**
 * The bank's transaction format (ISO 20022 via Enable Banking) into Geld's own. Amounts become
 * signed cents; the counterparty is whoever is on the other side.
 */

import type { BankAccount, BankBalance, BankTransaction } from './enable.js'
import type { MoneyAccount, MoneyTransaction } from '../../contract/types.js'

/** FNV-1a, 64 bits as hex: a stable id from the bank's own reference, the same on every fetch. */
function hash(input: string): string {
  let h = 0xcbf29ce484222325n
  for (const char of input) {
    h ^= BigInt(char.codePointAt(0)!)
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return h.toString(16).padStart(16, '0')
}

export function toCents(amount: string): number {
  const value = Number(amount)
  if (!Number.isFinite(value)) throw new Error(`Geen bedrag: ${amount}`)
  return Math.round(value * 100)
}

const titleCase = (value: string): string =>
  value === value.toUpperCase() ? value.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_, before: string, letter: string) => before + letter.toUpperCase()) : value

/**
 * The shop behind a card payment. ABN AMRO names the other side "POS NATIONAL" or "POS
 * INTERNATIONAL" and puts the shop in the text: "BEA, Apple Pay Jumbo Zevenaar,PAS574 NR:…",
 * "eCom, Apple Pay Revolut**5411* 28.09.26/10:00". Everything else keeps the name it has.
 */
export function merchantName(counterparty: string, description: string): string {
  if (counterparty && !/^POS (INTER)?NATIONAL$/i.test(counterparty.trim())) return counterparty
  const match = /(?:BEA|GEA|eCom|CCV)\s*,\s*(?:Apple Pay |Google Pay |Betaalpas |Contactloos )?(.+?)(?:,\s*PAS\d+|\s+NR:|\s+\d{2}\.\d{2}\.\d{2}\/|$)/i.exec(description)
  if (!match) return counterparty || description.slice(0, 40)
  let name = match[1]!
    .replace(/^[A-Z]{2,4}\*\d+\s+/, '')
    .replace(/\*+\d*\*?.*$/, '')
    .trim()
  const words = name.split(/\s+/)
  if (words.length > 1 && words[0]!.toLowerCase() === words[1]!.toLowerCase()) name = words.slice(1).join(' ')
  return titleCase(name) || counterparty
}

export function mapTransaction(accountUid: string, transaction: BankTransaction): MoneyTransaction {
  const incoming = transaction.credit_debit_indicator === 'CRDT'
  const cents = Math.abs(toCents(transaction.transaction_amount.amount))
  const date = transaction.booking_date ?? transaction.value_date ?? transaction.transaction_date ?? ''
  const other = incoming ? transaction.debtor : transaction.creditor
  const otherAccount = incoming ? transaction.debtor_account : transaction.creditor_account
  const description = [...(transaction.remittance_information ?? []), transaction.note ?? '']
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  const pending = transaction.status !== undefined && transaction.status !== 'BOOK'
  const reference = transaction.entry_reference || transaction.transaction_id
  const key = reference ? `${accountUid}|${reference}` : `${accountUid}|${date}|${incoming ? '+' : '-'}${cents}|${description}`
  return {
    id: `tx-${hash(key)}`,
    accountUid,
    date,
    amountCents: incoming ? cents : -cents,
    counterparty: merchantName((other?.name ?? transaction.bank_transaction_code?.description ?? '').trim(), description),
    counterIban: otherAccount?.iban?.replace(/\s+/g, '').toUpperCase() ?? null,
    description,
    pending,
    kind: null,
    refId: null,
    manual: false
  }
}

/** The balance to show: what is available, else what was booked. */
export function pickBalance(balances: BankBalance[]): BankBalance | null {
  const order = ['CLAV', 'ITAV', 'CLBD', 'ITBD', 'XPCD', 'OPAV', 'OPBD']
  return [...balances].sort((a, b) => indexOf(order, a.balance_type) - indexOf(order, b.balance_type))[0] ?? null
}

function indexOf(order: string[], value: string): number {
  const index = order.indexOf(value)
  return index < 0 ? order.length : index
}

export function mapAccount(account: BankAccount): Omit<MoneyAccount, 'balanceCents' | 'balanceDate' | 'lockedUntil'> {
  const savings = account.cash_account_type === 'SVGS' || /spaar|saving/i.test(`${account.name ?? ''} ${account.product ?? ''}`)
  return {
    uid: account.uid,
    iban: account.account_id?.iban?.replace(/\s+/g, '').toUpperCase() ?? '',
    name: account.name || account.product || (savings ? 'Spaarrekening' : 'Betaalrekening'),
    role: savings ? 'spaar' : 'betaal'
  }
}
