/**
 * Who is logged in, and for how long.
 *
 * A session is a random 32-byte id in an HttpOnly cookie and a row in memory. It is written
 * to disk as well, so a restart of the service does not throw both readers out mid-sentence,
 * and expired rows are dropped on every read rather than by a timer — a server nobody is
 * using should not be doing work.
 *
 * There is no refresh-on-activity. A login lasts its hours and then ends, which is the
 * behaviour you want for an account that belongs to somebody else.
 */

import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

export class Sessions {
  constructor(file, hours) {
    this.file = file
    this.ttlMs = Math.max(1, hours) * 3_600_000
    this.rows = new Map()
    this.load()
  }

  load() {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      for (const row of parsed.sessions ?? []) this.rows.set(row.id, row)
    } catch {
      // No file yet, or an unreadable one: starting with nobody logged in is always safe.
    }
    this.sweep()
  }

  persist() {
    try {
      writeFileSync(this.file, JSON.stringify({ sessions: [...this.rows.values()] }), { mode: 0o600 })
    } catch {
      // A session store that cannot be written still works for this process; losing it on
      // restart is an inconvenience, not a reason to refuse a login.
    }
  }

  sweep() {
    const now = Date.now()
    for (const [id, row] of this.rows) {
      if (row.expiresAt <= now) this.rows.delete(id)
    }
  }

  create(user) {
    const id = randomBytes(32).toString('base64url')
    this.rows.set(id, {
      id,
      username: user.username,
      role: user.role,
      // Carried in every form on the admin pages and checked before anything is changed.
      // SameSite=Strict already stops a cross-site POST in every browser that honours it;
      // this is the belt to that pair of braces, and it costs one hidden input.
      csrf: randomBytes(24).toString('base64url'),
      startedAt: Date.now(),
      expiresAt: Date.now() + this.ttlMs
    })
    this.persist()
    return id
  }

  /** Everyone currently logged in, newest first. The admin page lists this. */
  list() {
    this.sweep()
    return [...this.rows.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  }

  /** Ends every session of one account — used when a password is reset or an account goes. */
  destroyFor(username) {
    for (const [id, row] of this.rows) {
      if (row.username === username) this.rows.delete(id)
    }
    this.persist()
  }

  get(id) {
    if (!id) return null
    this.sweep()
    return this.rows.get(id) ?? null
  }

  destroy(id) {
    if (!id) return
    this.rows.delete(id)
    this.persist()
  }
}
