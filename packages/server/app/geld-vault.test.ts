import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { openStore } from '@core/db/index.js'
import { MoneyVault, type VaultTransport } from '@core/money/vault.js'
import { GeldVault } from './geld-vault.js'

describe('the server end of Geld', () => {
  it('keeps two devices in step through its file, which stays unreadable, and survives a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uurwerk-vault-'))
    try {
      let server = new GeldVault(dir)
      // Through JSON, as over HTTP.
      const transport: VaultTransport = {
        get: async (since) => JSON.parse(JSON.stringify(server.feed(since))),
        post: async (body) => server.put(JSON.parse(JSON.stringify(body)))
      }
      const laptop = openStore(':memory:')
      laptop.money.loadStarter()
      laptop.money.addEntry({ date: '2026-11-14', kind: 'spend', amountCents: 1400, note: 'GEHEIMEFRIETTENT', category: null })
      const a = new MoneyVault(laptop.db)
      const keyA = await a.setup('een lange wachtwoordzin', transport)
      await a.round(keyA, transport)

      const file = readFileSync(join(dir, 'geld-vault.json'), 'utf8')
      expect(file).not.toContain('GEHEIMEFRIETTENT')
      expect(file).not.toContain('Zorgverzekering')

      server = new GeldVault(dir)
      const phone = openStore(':memory:')
      const b = new MoneyVault(phone.db)
      const keyB = await b.setup('een lange wachtwoordzin', transport)
      await b.round(keyB, transport)
      expect(phone.money.state().entries.map((entry) => entry.note)).toEqual(['GEHEIMEFRIETTENT'])

      expect(() => server.put({ records: [{ key: 'not-a-hash', blob: 'x' }] })).toThrow()
      expect(() => server.put({ salt: 'another', records: [] })).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
