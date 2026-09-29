import { describe, expect, it } from 'vitest'

import { openStore } from '../../db/index.js'
import { milestonePaid, potAccount, savedSoFar } from '../projection.js'
import { budgetStatus, closingProposal, shiftPayIn } from '../status.js'
import { makeJwt, type BankTransaction } from './enable.js'
import { mapAccount, mapTransaction, pickBalance } from './map.js'

const BETAAL = 'NL11ABNA0000000001'
const SPAAR = 'NL22ABNA0000000002'

function tx(date: string, euros: number, name: string, extra: Partial<BankTransaction> = {}): BankTransaction {
  const incoming = euros > 0
  return {
    entry_reference: `${date}-${name}-${euros}`,
    transaction_amount: { amount: Math.abs(euros).toFixed(2), currency: 'EUR' },
    credit_debit_indicator: incoming ? 'CRDT' : 'DBIT',
    status: 'BOOK',
    booking_date: date,
    remittance_information: [name],
    ...(incoming ? { debtor: { name } } : { creditor: { name } }),
    ...extra
  }
}

function linkedStore() {
  const store = openStore(':memory:')
  store.money.loadStarter()
  store.money.saveAccount({ uid: 'acc-betaal', iban: BETAAL, name: 'Betaalrekening', role: 'betaal', balanceCents: 84240, balanceDate: '2026-11-17' })
  store.money.saveManualSavings({ iban: SPAAR, name: 'Reis', balanceCents: 0, date: '2026-10-31', lockedUntil: '2027-04-07' })
  return store
}

describe('Geld and the bank', () => {
  it('maps the bank format to signed cents and a stable id', () => {
    const out = mapTransaction('acc', tx('2026-11-05', -12.5, 'Friettent'))
    const again = mapTransaction('acc', tx('2026-11-05', -12.5, 'Friettent'))
    expect(out.amountCents).toBe(-1250)
    expect(out.counterparty).toBe('Friettent')
    expect(out.id).toBe(again.id)
    expect(mapAccount({ uid: 'u', account_id: { iban: 'NL22 ABNA 0000 0000 02' }, cash_account_type: 'SVGS' }).role).toBe('spaar')
    expect(pickBalance([{ balance_type: 'OPBD', balance_amount: { amount: '1', currency: 'EUR' } }, { balance_type: 'CLAV', balance_amount: { amount: '2', currency: 'EUR' } }])?.balance_type).toBe('CLAV')
  })

  it('sorts a month of ABN transactions into the plan', () => {
    const store = linkedStore()
    store.money.storeTransactions(
      'acc-betaal',
      [
        tx('2026-11-01', -176.29, 'Zorgverzekeraar'),
        tx('2026-11-02', -323.36, 'DUO'),
        tx('2026-11-05', 257.36, 'Adecco Payroll'),
        tx('2026-11-08', -23.9, 'Zalando'),
        tx('2026-11-14', -14, 'Friettent'),
        tx('2026-11-20', 129, 'Belastingdienst'),
        tx('2026-11-25', 600, 'Stichting stagevergoeding'),
        tx('2026-11-26', -1020, 'Hidde Reis', { creditor_account: { iban: SPAAR } }),
        tx('2026-11-27', -499, 'Coolblue')
      ].map((item) => mapTransaction('acc-betaal', item))
    )
    const state = store.money.state()
    const kinds = Object.fromEntries(state.transactions.map((item) => [item.counterparty, `${item.kind}${item.refId ? `:${item.refId}` : ''}`]))
    expect(kinds).toMatchObject({
      Zorgverzekeraar: 'cost:cost-zorg',
      DUO: 'cost:cost-school',
      'Adecco Payroll': 'shiftPay',
      Zalando: 'spend',
      Friettent: 'spend',
      Belastingdienst: 'income:income-belastingdienst',
      'Stichting stagevergoeding': 'income:income-stage',
      'Hidde Reis': 'saving',
      Coolblue: 'null'
    })
    expect(budgetStatus(state, '2026-11-17').spentCents).toBe(3790)
    expect(shiftPayIn(state, '2026-11')).toBe(25736)
    // The savings balance follows the transfer that the current account shows.
    expect(potAccount(state)?.balanceCents).toBe(102000)
  })

  it('treats money out of the locked pot as a milestone when a flight is due, else as borrowed', () => {
    const store = linkedStore()
    store.money.storeTransactions(
      'acc-betaal',
      [
        tx('2026-11-26', -2000, 'Hidde Reis', { creditor_account: { iban: SPAAR } }),
        tx('2026-12-12', 750, 'Hidde Reis', { debtor_account: { iban: SPAAR } }),
        tx('2026-12-12', -748, 'KLM'),
        tx('2026-12-20', 80, 'Hidde Reis', { debtor_account: { iban: SPAAR } })
      ].map((item) => mapTransaction('acc-betaal', item))
    )
    const state = store.money.state()
    const byDate = state.transactions.map((item) => `${item.date} ${item.counterparty} ${item.kind}`)
    expect(byDate).toContain('2026-12-12 Hidde Reis milestone')
    expect(byDate).toContain('2026-12-12 KLM milestone')
    expect(byDate).toContain('2026-12-20 Hidde Reis borrowed')
    expect(milestonePaid(state, state.milestones[0]!)).toBe(true)
    // Pot: 2000 in, 750 and 80 out. Saved counts the flight as spent, not lost.
    expect(potAccount(state)?.balanceCents).toBe(117000)
    expect(savedSoFar(state)).toBe(117000 + 75000)
    // The closing puts the €80 back on top of the plan.
    expect(closingProposal(state, '2026-12').borrowedCents).toBe(8000)
    expect(closingProposal(state, '2026-12').targetCents).toBe(102000 + 8000)
  })

  it('keeps what you sorted by hand, and learns a rule from it', () => {
    const store = linkedStore()
    store.money.storeTransactions('acc-betaal', [mapTransaction('acc-betaal', tx('2026-11-27', -499, 'Coolblue'))])
    const id = store.money.state().transactions[0]!.id
    store.money.sortTransaction(id, 'ignore', null, true)
    store.money.storeTransactions('acc-betaal', [mapTransaction('acc-betaal', tx('2026-12-03', -89, 'Coolblue'))])
    const kinds = store.money.state().transactions.map((item) => item.kind)
    expect(kinds).toEqual(['ignore', 'ignore'])
    expect(store.money.state().rules.map((rule) => rule.pattern)).toEqual(['coolblue'])
  })

  it('signs the JWT with the application key (RS256)', async () => {
    const pair = await globalThis.crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify']
    )
    const pkcs8 = new Uint8Array(await globalThis.crypto.subtle.exportKey('pkcs8', pair.privateKey))
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END PRIVATE KEY-----`
    const jwt = await makeJwt({ applicationId: 'app-123', privateKeyPem: pem }, 1_800_000_000)
    const [header, claims, signature] = jwt.split('.')
    const decode = (part: string) => JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')))
    expect(decode(header!)).toEqual({ typ: 'JWT', alg: 'RS256', kid: 'app-123' })
    expect(decode(claims!)).toMatchObject({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: 1_800_000_000 })
    const raw = atob(signature!.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0))
    const ok = await globalThis.crypto.subtle.verify('RSASSA-PKCS1-v1_5', pair.publicKey, bytes, new TextEncoder().encode(`${header}.${claims}`))
    expect(ok).toBe(true)
  })
})

describe('shop names in ABN AMRO card payments', () => {
  it('finds the shop behind POS NATIONAL', async () => {
    const { merchantName } = await import('./map.js')
    expect(merchantName('POS NATIONAL', 'BEA, Apple Pay Jumbo Zevenaar Oldebar,PAS574 NR:304S95')).toBe('Jumbo Zevenaar Oldebar')
    expect(merchantName('POS NATIONAL', 'BEA, Apple Pay SPAR LEENDERS,PAS574 NR:304S95')).toBe('Spar Leenders')
    expect(merchantName('POS INTERNATIONAL', 'eCom, Apple Pay Revolut**5411* 28.09.26/10:00')).toBe('Revolut')
    expect(merchantName('POS NATIONAL', 'BEA, Apple Pay BCK*5831 AH AH to Go,PAS574 NR:1')).toBe('AH to Go')
    expect(merchantName('Ecovi', 'SEPA Overboeking IBAN: NL64KNAB0417017855')).toBe('Ecovi')
  })
})

describe('the plan against the bank', () => {
  it('finds the Jumbo salary, a moved cost day, and planned costs the bank never shows', async () => {
    const { checkPlan } = await import('./recurring.js')
    const store = linkedStore()
    const months = ['2026-06', '2026-07', '2026-08', '2026-09']
    store.money.storeTransactions(
      'acc-betaal',
      months.flatMap((month) => [
        tx(`${month}-22`, 717.4, 'Jumbo Supermarkten B.V.'),
        tx(`${month}-28`, -176.29, 'DE CHRISTELIJKE'),
        tx(`${month}-25`, -30, 'ODIDO NETHERLANDS B.V.'),
        tx(`${month}-14`, 52, 'AAB INZ TIKKIE'),
        tx(`${month}-10`, 20, 'Betaalrekening', { debtor: { name: 'Betaalrekening' } })
      ]).map((item) => mapTransaction('acc-betaal', item))
    )
    const state = store.money.state()
    const check = checkPlan(state, '2026-09-29')
    const byName = Object.fromEntries(check.recurring.map((item) => [item.name, item]))
    expect(byName['Jumbo Supermarkten B.V.']).toMatchObject({ direction: 'in', amountCents: 71740, day: 22, match: null })
    expect(byName['DE CHRISTELIJKE']?.match?.item.id).toBe('cost-zorg')
    expect(byName['DE CHRISTELIJKE']?.differs).toEqual({ day: 28 })
    expect(byName['ODIDO NETHERLANDS B.V.']).toMatchObject({ amountCents: 3000, day: 25, match: null })
    expect(byName['AAB INZ TIKKIE']).toBeUndefined()
    expect(byName['Betaalrekening']).toBeUndefined()
    expect(check.missing.map((item) => item.id)).toContain('cost-school')
    // Tikkie back lowers the budget spend.
    expect(state.transactions.find((item) => item.counterparty === 'AAB INZ TIKKIE')?.kind).toBe('spend')
  })
})
