/**
 * ★ SECURITY-CRITICAL ★
 *
 * The devices that hold a full copy of your data: the laptop, later the phone.
 *
 * A device token opens everything under /api — every task, every hour, every screenshot —
 * so it is treated like a password that happens to be long: 32 random bytes, shown once
 * when it is made, stored here only as a SHA-256 hash. A stolen devices.json is therefore
 * useless, and a lost laptop is one `uurwerk-devices remove laptop` away from locked out.
 *
 * SHA-256 rather than scrypt: the token has 256 bits of entropy, so there is nothing for a
 * slow hash to protect against, and the check runs on every sync round.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/

const hash = (token) => createHash('sha256').update(token, 'utf8').digest()

export class DeviceStore {
  constructor(file) {
    this.file = file
    this.seen = new Map()
  }

  read() {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      return []
    }
  }

  write(rows) {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(rows, null, 2), { mode: 0o600 })
  }

  /** Makes a device and returns its token — the only time the token exists in the clear. */
  add(name) {
    if (!NAME.test(name)) throw new Error('Een apparaatnaam: kleine letters, cijfers en streepjes, zoals "laptop".')
    const rows = this.read().filter((row) => row.name !== name)
    const token = `uw_${randomBytes(32).toString('hex')}`
    rows.push({ name, hash: hash(token).toString('hex'), createdAt: Date.now() })
    this.write(rows)
    return token
  }

  remove(name) {
    const rows = this.read()
    const kept = rows.filter((row) => row.name !== name)
    this.write(kept)
    return kept.length !== rows.length
  }

  list() {
    return this.read().map(({ name, createdAt }) => ({
      name,
      createdAt,
      lastSeen: this.seen.get(name) ?? null
    }))
  }

  /** The device behind a bearer header, or null. */
  verify(header) {
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!token.startsWith('uw_')) return null
    const given = hash(token)
    for (const row of this.read()) {
      const stored = Buffer.from(row.hash, 'hex')
      if (stored.length === given.length && timingSafeEqual(stored, given)) {
        this.seen.set(row.name, Date.now())
        return row.name
      }
    }
    return null
  }
}
