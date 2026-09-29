import { describe, expect, it } from 'vitest'

import { openStore } from '../db/index.js'
import { MoneyVault, type VaultFeed, type VaultPush, type VaultTransport } from './vault.js'

/** The server's side, as the real one keeps it: opaque records under opaque keys, numbered. */
function fakeServer() {
  const records = new Map<string, { blob: string; seq: number }>()
  let salt: string | null = null
  let check: string | null = null
  let seq = 0
  const transport: VaultTransport = {
    async get(since: number): Promise<VaultFeed> {
      return {
        salt,
        check,
        seq,
        records: [...records.entries()].filter(([, record]) => record.seq > since).map(([key, record]) => ({ key, ...record }))
      }
    },
    async post(body: VaultPush) {
      if (body.salt && !salt) {
        salt = body.salt
        check = body.check ?? null
      }
      for (const record of body.records) records.set(record.key, { blob: record.blob, seq: ++seq })
      return { seq }
    }
  }
  return { transport, records }
}

const PASS = 'correct horse battery'

describe('Geld between devices', () => {
  it('carries the plan from laptop to phone, and nothing readable reaches the server', async () => {
    const server = fakeServer()
    const laptop = openStore(':memory:')
    const phone = openStore(':memory:')
    laptop.money.loadStarter()
    laptop.money.addEntry({ date: '2026-11-10', kind: 'spend', amountCents: 1400, note: 'GEHEIMEFRIETTENT', category: 'Eten buiten' })

    const laptopVault = new MoneyVault(laptop.db)
    const key = await laptopVault.setup(PASS, server.transport)
    await laptopVault.round(key, server.transport)

    const everything = JSON.stringify([...server.records.entries()])
    expect(everything).not.toContain('GEHEIMEFRIETTENT')
    expect(everything).not.toContain('_geld_')
    expect(everything).not.toContain('Zorgverzekering')

    const phoneVault = new MoneyVault(phone.db)
    const phoneKey = await phoneVault.setup(PASS, server.transport)
    const result = await phoneVault.round(phoneKey, server.transport)
    expect(result.applied).toBeGreaterThan(20)
    const state = phone.money.state()
    expect(state.costs).toHaveLength(8)
    expect(state.entries[0]?.note).toBe('GEHEIMEFRIETTENT')
    expect(state.goal?.onAccountCents).toBe(540000)
    // What arrived is not queued to go straight back.
    expect(phoneVault.pending()).toBe(0)
  })

  it('refuses a wrong passphrase instead of starting a second vault', async () => {
    const server = fakeServer()
    const laptop = openStore(':memory:')
    await new MoneyVault(laptop.db).setup(PASS, server.transport)
    await expect(new MoneyVault(openStore(':memory:').db).setup('iets anders helemaal', server.transport)).rejects.toThrow(/past niet/)
  })

  it('sends edits and deletes both ways, the later edit winning', async () => {
    const server = fakeServer()
    const laptop = openStore(':memory:')
    const phone = openStore(':memory:')
    laptop.money.loadStarter()
    const a = new MoneyVault(laptop.db)
    const b = new MoneyVault(phone.db)
    const keyA = await a.setup(PASS, server.transport)
    await a.round(keyA, server.transport)
    const keyB = await b.setup(PASS, server.transport)
    await b.round(keyB, server.transport)

    // On the phone: a spend and a cost removed.
    const spend = phone.money.addEntry({ date: '2026-11-12', kind: 'spend', amountCents: 800, note: 'Bioscoop', category: 'Uitgaan' })
    phone.money.removeCost('cost-hbo')
    await b.round(keyB, server.transport)
    await a.round(keyA, server.transport)
    expect(laptop.money.state().entries.map((entry) => entry.id)).toContain(spend.id)
    expect(laptop.money.state().costs.map((cost) => cost.id)).not.toContain('cost-hbo')

    // On the laptop, later: the spend removed again.
    await new Promise((resolve) => setTimeout(resolve, 5))
    laptop.money.removeEntry(spend.id)
    await a.round(keyA, server.transport)
    await b.round(keyB, server.transport)
    expect(phone.money.state().entries).toEqual([])
  })
})
