/**
 * ★ Geld between laptop and phone, end to end encrypted. ★
 *
 * The rows never reach the server in the clear. Each row travels as one sealed record:
 * AES-GCM over {table, id, row, updatedAt}, filed under an HMAC of table and id so the server
 * can replace a record without learning what it is. The key comes from a passphrase you type
 * once per device (PBKDF2, 310 000 rounds, a salt the server keeps); the server never sees the
 * passphrase or the key, and neither do the supervisor, the teacher or Jarvis.
 *
 * What changed locally is written to `_geld_outbox` by triggers (money/schema.ts), so no write
 * path can forget. Rows applied from the server are written with the triggers held off, so
 * they are not sent straight back. Conflicts: the later edit wins, per row — the same rule as
 * the main sync.
 *
 * WebCrypto only: it is in Node (laptop, server) and in the phone's web view alike.
 */

import type { Db } from '../db/connection.js'
import { MONEY_TABLES } from './schema.js'

const ITERATIONS = 310_000
const CHECK = 'uurwerk-geld'

type MoneyTable = (typeof MONEY_TABLES)[number]

/** The primary key and the "last edited" column of each table. */
const SHAPE: Record<MoneyTable, { pk: string; updated: string }> = {
  _geld_incomes: { pk: 'id', updated: 'updated_at' },
  _geld_costs: { pk: 'id', updated: 'updated_at' },
  _geld_phases: { pk: 'id', updated: 'updated_at' },
  _geld_goals: { pk: 'id', updated: 'updated_at' },
  _geld_milestones: { pk: 'id', updated: 'updated_at' },
  _geld_entries: { pk: 'id', updated: 'updated_at' },
  _geld_shifts: { pk: 'id', updated: 'updated_at' },
  _geld_profiles: { pk: 'id', updated: 'updated_at' },
  _geld_closings: { pk: 'month', updated: 'closed_at' },
  _geld_accounts: { pk: 'uid', updated: 'updated_at' },
  _geld_transactions: { pk: 'id', updated: 'updated_at' },
  _geld_rules: { pk: 'id', updated: 'updated_at' }
}

export interface VaultFeed {
  salt: string | null
  check: string | null
  seq: number
  records: Array<{ key: string; blob: string; seq: number }>
}

export interface VaultPush {
  salt?: string
  check?: string
  records: Array<{ key: string; blob: string }>
}

/** How a device reaches the server's vault: its own sync client supplies this. */
export interface VaultTransport {
  get(since: number): Promise<VaultFeed>
  post(body: VaultPush): Promise<{ seq: number }>
}

interface Sealed {
  t: MoneyTable
  id: string
  row: Record<string, string | number | null> | null
  u: number
}

// ------------------------------------------------------------------ crypto

const subtle = (): SubtleCrypto => {
  const crypto = globalThis.crypto
  if (!crypto?.subtle) throw new Error('Versleuteling is hier niet beschikbaar.')
  return crypto.subtle
}

function toBase64(bytes: Uint8Array): string {
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text)
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const raw = atob(text)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index)
  return bytes
}

export function newSalt(): string {
  return toBase64(globalThis.crypto.getRandomValues(new Uint8Array(16)))
}

/** 64 bytes from the passphrase: the first half encrypts, the second names records. Base64. */
export async function deriveMaterial(passphrase: string, salt: string): Promise<string> {
  if (passphrase.trim().length < 8) throw new Error('Kies een wachtwoordzin van minstens 8 tekens.')
  const base = await subtle().importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveBits'])
  const bits = await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64(salt), iterations: ITERATIONS }, base, 512)
  return toBase64(new Uint8Array(bits))
}

interface Keys {
  enc: CryptoKey
  mac: CryptoKey
}

const keyCache = new Map<string, Promise<Keys>>()

function keysFrom(material: string): Promise<Keys> {
  let keys = keyCache.get(material)
  if (!keys) {
    const bytes = fromBase64(material)
    keys = Promise.all([
      subtle().importKey('raw', bytes.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']),
      subtle().importKey('raw', bytes.slice(32, 64), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    ]).then(([enc, mac]) => ({ enc, mac }))
    keyCache.set(material, keys)
  }
  return keys
}

export async function seal(material: string, value: unknown): Promise<string> {
  const { enc } = await keysFrom(material)
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const body = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, enc, new TextEncoder().encode(JSON.stringify(value))))
  const out = new Uint8Array(iv.length + body.length)
  out.set(iv)
  out.set(body, iv.length)
  return toBase64(out)
}

export async function unseal<T>(material: string, blob: string): Promise<T> {
  const { enc } = await keysFrom(material)
  const bytes = fromBase64(blob)
  const plain = await subtle().decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, enc, bytes.slice(12))
  return JSON.parse(new TextDecoder().decode(plain)) as T
}

async function recordKey(material: string, table: string, id: string): Promise<string> {
  const { mac } = await keysFrom(material)
  const signature = new Uint8Array(await subtle().sign('HMAC', mac, new TextEncoder().encode(`${table}\u0000${id}`)))
  return [...signature].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

// ------------------------------------------------------------------ rounds

export interface VaultRoundResult {
  pushed: number
  applied: number
  tables: Set<string>
}

export class MoneyVault {
  constructor(private readonly db: Db) {}

  private getState(key: string): string | null {
    return this.db.get<{ v: string }>('SELECT v FROM _geld_sync_state WHERE k = ?', [key])?.v ?? null
  }

  private setState(key: string, value: string | null): void {
    if (value === null) this.db.run('DELETE FROM _geld_sync_state WHERE k = ?', [key])
    else this.db.run('INSERT OR REPLACE INTO _geld_sync_state (k, v) VALUES (?, ?)', [key, value])
  }

  pending(): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM _geld_outbox')?.n ?? 0
  }

  lastSeq(): number {
    return Number(this.getState('seq') ?? '0')
  }

  /** Queues every row, for the first push from a device. */
  private queueEverything(): void {
    const now = Date.now()
    for (const table of MONEY_TABLES) {
      const { pk } = SHAPE[table]
      this.db.run(`INSERT OR IGNORE INTO _geld_outbox (tbl, id, at) SELECT ?, ${pk}, ? FROM ${table}`, [table, now])
    }
  }

  /**
   * Opens the vault with a passphrase: creates it when the server has none yet, joins it
   * when it does (a wrong passphrase is refused, not silently forked). Returns the key
   * material for the caller to keep in its secret store.
   */
  async setup(passphrase: string, transport: VaultTransport): Promise<string> {
    const feed = await transport.get(Number.MAX_SAFE_INTEGER)
    if (feed.salt && feed.check) {
      const material = await deriveMaterial(passphrase, feed.salt)
      const check = await unseal<string>(material, feed.check).catch(() => null)
      if (check !== CHECK) throw new Error('Deze wachtwoordzin past niet bij de kluis op de server.')
      this.setState('seq', '0')
      this.queueEverything()
      return material
    }
    const salt = newSalt()
    const material = await deriveMaterial(passphrase, salt)
    await transport.post({ salt, check: await seal(material, CHECK), records: [] })
    this.setState('seq', '0')
    this.queueEverything()
    return material
  }

  forget(): void {
    this.setState('seq', null)
    this.db.run('DELETE FROM _geld_outbox')
  }

  /** Push what changed here, pull what changed elsewhere. */
  async round(material: string, transport: VaultTransport): Promise<VaultRoundResult> {
    const pushed = await this.push(material, transport)
    const { applied, tables } = await this.pull(material, transport)
    return { pushed, applied, tables }
  }

  private async push(material: string, transport: VaultTransport): Promise<number> {
    const queued = this.db.all<{ tbl: MoneyTable; id: string; at: number }>('SELECT tbl, id, at FROM _geld_outbox')
    if (queued.length === 0) return 0
    const records: VaultPush['records'] = []
    for (const item of queued) {
      const shape = SHAPE[item.tbl]
      if (!shape) continue
      const row = this.db.get<Record<string, string | number | null>>(`SELECT * FROM ${item.tbl} WHERE ${shape.pk} = ?`, [item.id]) ?? null
      const sealed: Sealed = { t: item.tbl, id: item.id, row, u: row ? Number(row[shape.updated] ?? item.at) : item.at }
      records.push({ key: await recordKey(material, item.tbl, item.id), blob: await seal(material, sealed) })
    }
    await transport.post({ records })
    // Only what was sent: an edit made while the request was out stays queued.
    for (const item of queued) this.db.run('DELETE FROM _geld_outbox WHERE tbl = ? AND id = ? AND at = ?', [item.tbl, item.id, item.at])
    return records.length
  }

  private async pull(material: string, transport: VaultTransport): Promise<{ applied: number; tables: Set<string> }> {
    const feed = await transport.get(this.lastSeq())
    const tables = new Set<string>()
    let applied = 0
    const opened: Sealed[] = []
    for (const record of feed.records) opened.push(await unseal<Sealed>(material, record.blob))

    this.db.transaction(() => {
      this.setState('applying', '1')
      try {
        for (const incoming of opened) {
          if (this.apply(incoming)) {
            applied += 1
            tables.add(incoming.t)
          }
        }
      } finally {
        this.setState('applying', null)
      }
      this.setState('seq', String(feed.seq))
    })
    return { applied, tables }
  }

  /** The later edit wins; a local edit still waiting to go out counts as later than anything older. */
  private apply(incoming: Sealed): boolean {
    const shape = SHAPE[incoming.t]
    if (!shape) return false
    const waiting = this.db.get<{ at: number }>('SELECT at FROM _geld_outbox WHERE tbl = ? AND id = ?', [incoming.t, incoming.id])
    if (waiting && waiting.at > incoming.u) return false
    const local = this.db.get<Record<string, string | number | null>>(`SELECT * FROM ${incoming.t} WHERE ${shape.pk} = ?`, [incoming.id])
    const localU = local ? Number(local[shape.updated] ?? 0) : 0
    if (local && incoming.row && localU >= incoming.u) return false

    if (!incoming.row) {
      if (!local || localU > incoming.u) return false
      this.db.run(`DELETE FROM ${incoming.t} WHERE ${shape.pk} = ?`, [incoming.id])
      return true
    }
    const columns = new Set(this.db.all<{ name: string }>(`PRAGMA table_info(${incoming.t})`).map((column) => column.name))
    const names = Object.keys(incoming.row).filter((name) => columns.has(name))
    if (!names.includes(shape.pk)) return false
    this.db.run(
      `INSERT OR REPLACE INTO ${incoming.t} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
      names.map((name) => incoming.row![name] ?? null)
    )
    return true
  }
}
