/**
 * The server's end of Geld: a locker for sealed records it cannot open.
 *
 * Devices encrypt every Geld row before it leaves (core/money/vault.ts); what arrives here is a
 * key (an HMAC) and a blob (AES-GCM). The server numbers them so a device can ask "what is new
 * since n", keeps the salt and a sealed check value so a second device can tell a right
 * passphrase from a wrong one, and knows nothing else — not the tables, not the amounts.
 *
 * Its own file beside the database, on purpose: never in uurwerk.db, so never in a snapshot,
 * a backup of the main copy, or anything Jarvis or the reader pages can see.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { VaultFeed, VaultPush } from '@core/money/vault.js'

interface Stored {
  salt: string | null
  check: string | null
  seq: number
  records: Record<string, { blob: string; seq: number }>
}

const KEY = /^[0-9a-f]{64}$/
const MAX_BLOB = 64 * 1024
const MAX_RECORDS = 5_000

export class GeldVault {
  private readonly file: string
  private data: Stored

  constructor(dataDir: string) {
    this.file = join(dataDir, 'geld-vault.json')
    this.data = existsSync(this.file)
      ? (JSON.parse(readFileSync(this.file, 'utf8')) as Stored)
      : { salt: null, check: null, seq: 0, records: {} }
  }

  feed(since: number): VaultFeed {
    const records = Object.entries(this.data.records)
      .filter(([, record]) => record.seq > since)
      .map(([key, record]) => ({ key, blob: record.blob, seq: record.seq }))
      .sort((a, b) => a.seq - b.seq)
    return { salt: this.data.salt, check: this.data.check, seq: this.data.seq, records }
  }

  /** Stores sealed records. The salt is set once: a second one would split the vault in two. */
  put(body: VaultPush): { seq: number } {
    if (body.salt) {
      if (this.data.salt && this.data.salt !== body.salt) throw new Error('This vault already has a passphrase.')
      this.data.salt = body.salt
      this.data.check = body.check ?? null
    }
    const records = body.records ?? []
    if (records.length > MAX_RECORDS) throw new Error('Too many records in one push.')
    for (const record of records) {
      if (!KEY.test(record.key) || typeof record.blob !== 'string' || record.blob.length > MAX_BLOB) {
        throw new Error('Not a sealed record.')
      }
      this.data.seq += 1
      this.data.records[record.key] = { blob: record.blob, seq: this.data.seq }
    }
    this.save()
    return { seq: this.data.seq }
  }

  private save(): void {
    // Write-then-rename: a crash mid-write leaves the old file, never half a new one.
    const temp = `${this.file}.tmp`
    writeFileSync(temp, JSON.stringify(this.data), { mode: 0o600 })
    renameSync(temp, this.file)
  }
}
