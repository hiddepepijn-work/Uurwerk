/**
 * ★ Moving rows between copies of the database. ★
 *
 * One round, always in this order, driven by the device:
 *
 *   1. push  — the device sends every row it changed since the last push (`pendingChanges`);
 *              the server applies what is newer than its own copy of that row (`receive`).
 *   2. ack   — the device forgets what the server has taken (`acknowledge`).
 *   3. pull  — the server sends every row changed since the device last pulled, except the
 *              device's own (`feed`); the device applies them (`applyChanges`).
 *
 * Conflicts are per row, and the later edit wins. There is one person using this, so two
 * copies editing the same task while both are offline is rare; when it does happen, losing
 * the older of two edits to one row is the honest, explainable outcome.
 *
 * Nothing here does I/O beyond the database. The HTTP around it lives in the server and in
 * the desktop app, which keeps every rule in this file testable with two in-memory copies.
 */

import type { Db, Param } from '../db/connection.js'
import { DEVICE_LOCAL_SETTINGS, syncedTables, withoutLogging, type TableInfo } from './schema.js'

export type SyncValue = string | number | null

export interface RowChange {
  tbl: string
  /** JSON array of primary-key values, exactly as json_array() wrote it. */
  pk: string
  op: 'upsert' | 'delete'
  /** When the change was made, epoch ms, on the device that made it. */
  at: number
  /** The row as it is now; null for a delete. */
  row: Record<string, SyncValue> | null
}

export interface ApplyFailure {
  tbl: string
  pk: string
  error: string
}

export interface ReceiveResult {
  applied: number
  /** Rows the server already had a newer version of. The device gets that version on pull. */
  stale: number
  failed: ApplyFailure[]
}

export interface Feed {
  changes: RowChange[]
  /** The server's position after this feed: the device's next `since`. */
  seq: number
}

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`

/** The schema version: both sides must agree before any row crosses. */
export function schemaVersion(db: Db): number {
  return db.get<{ version: number }>('SELECT MAX(id) AS version FROM _migrations')?.version ?? 0
}

function tableMap(db: Db): Map<string, TableInfo> {
  return new Map(syncedTables(db).map((table) => [table.name, table]))
}

function toSyncValue(value: unknown): SyncValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number' || typeof value === 'string') return value
  // No table stores blobs; if one ever does, it has to be encoded before it can travel.
  throw new Error(`A value of type ${typeof value} cannot be synced.`)
}

function readRow(db: Db, table: TableInfo, pk: string): Record<string, SyncValue> | null {
  const values = JSON.parse(pk) as Param[]
  const where = table.pk.map((column) => `${quote(column)} = ?`).join(' AND ')
  const row = db.get<Record<string, unknown>>(
    `SELECT * FROM ${quote(table.name)} WHERE ${where}`,
    values
  )
  if (!row) return null
  const out: Record<string, SyncValue> = {}
  for (const [key, value] of Object.entries(row)) out[key] = toSyncValue(value)
  return out
}

/** Latest entry per row, in the order the rows were last touched. */
function latestPerRow(
  db: Db,
  since: number,
  excludeOrigin: string | null
): Array<{ seq: number; tbl: string; pk: string; op: 'upsert' | 'delete'; at: number }> {
  const rows = db.all<{
    seq: number
    tbl: string
    pk: string
    op: 'upsert' | 'delete'
    at: number
    origin: string | null
  }>(
    `SELECT seq, tbl, pk, op, at, origin FROM _changes
      WHERE seq IN (SELECT MAX(seq) FROM _changes WHERE seq > ? GROUP BY tbl, pk)
      ORDER BY seq`,
    [since]
  )
  // Filtered after picking the latest, not before: if the device's own edit is the newest
  // thing that happened to a row, the device already has it and there is nothing to send.
  return rows.filter((row) => excludeOrigin === null || row.origin !== excludeOrigin)
}

function withRows(db: Db, entries: ReturnType<typeof latestPerRow>): RowChange[] {
  const tables = tableMap(db)
  const changes: RowChange[] = []
  for (const entry of entries) {
    const table = tables.get(entry.tbl)
    if (!table) continue
    // The row as it is now, not as it was at the time: a later edit already folded in.
    const row = entry.op === 'upsert' ? readRow(db, table, entry.pk) : null
    changes.push({
      tbl: entry.tbl,
      pk: entry.pk,
      op: row ? 'upsert' : 'delete',
      at: entry.at,
      row
    })
  }
  return changes
}

// ------------------------------------------------------------------ device

/** Everything this copy changed and has not handed over yet. */
export function pendingChanges(db: Db): { changes: RowChange[]; upTo: number } {
  const upTo = db.get<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM _changes')?.seq ?? 0
  return { changes: withRows(db, latestPerRow(db, 0, null)), upTo }
}

/** The server has these; the log up to `upTo` can go. */
export function acknowledge(db: Db, upTo: number): void {
  db.run('DELETE FROM _changes WHERE seq <= ?', [upTo])
}

export function lastPulled(db: Db): number {
  return db.get<{ last: number }>('SELECT last_pulled AS last FROM _sync_state WHERE id = 1')?.last ?? 0
}

export function setLastPulled(db: Db, seq: number): void {
  db.run('UPDATE _sync_state SET last_pulled = ? WHERE id = 1', [seq])
}

export function deviceId(db: Db): string | null {
  return db.get<{ id: string | null }>('SELECT device_id AS id FROM _sync_state WHERE id = 1')?.id ?? null
}

/**
 * Turns a freshly downloaded copy of the server's database into this device's copy.
 *
 * The file arrives with the server's own log and state in it; neither is this device's.
 */
export function adoptSnapshot(db: Db, device: string, seq: number): void {
  db.run('DELETE FROM _changes')
  db.run('UPDATE _sync_state SET device_id = ?, last_pulled = ?, applying = 0 WHERE id = 1', [
    device,
    seq
  ])
}

// ------------------------------------------------------------------ server

/** What the server sends a device: every row that moved since `since`, minus its own. */
export function feed(db: Db, since: number, device: string): Feed {
  const seq = db.get<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM _changes')?.seq ?? 0
  return { changes: withRows(db, latestPerRow(db, since, device)), seq }
}

/**
 * Takes a device's changes, row by row, keeping whichever version of each row is newer.
 *
 * Each applied row is logged under the device's name and with the time the device made the
 * change, so the next device to pull gets it and so a later, older push loses to it.
 */
export function receive(db: Db, device: string, changes: RowChange[]): ReceiveResult {
  const result: ReceiveResult = { applied: 0, stale: 0, failed: [] }
  const fresh: RowChange[] = []

  for (const change of changes) {
    const latest = db.get<{ at: number }>(
      'SELECT at FROM _changes WHERE tbl = ? AND pk = ? ORDER BY seq DESC LIMIT 1',
      [change.tbl, change.pk]
    )
    if (latest && latest.at > change.at) result.stale += 1
    else fresh.push(change)
  }

  const outcome = applyRows(db, fresh, (change) => {
    db.run('INSERT INTO _changes (tbl, pk, op, at, origin) VALUES (?, ?, ?, ?, ?)', [
      change.tbl,
      change.pk,
      change.op,
      change.at,
      device
    ])
  })
  result.applied = outcome.applied
  result.failed = outcome.failed
  return result
}

/**
 * Keeps one log entry per row. The feed only ever reads the newest entry for a row, so the
 * older ones are dead weight — and on a server that sees every edit for years, a lot of it.
 */
export function compact(db: Db): number {
  return db.run(
    'DELETE FROM _changes WHERE seq NOT IN (SELECT MAX(seq) FROM _changes GROUP BY tbl, pk)'
  ).changes
}

// ------------------------------------------------------------------ both

/**
 * Applies rows from elsewhere, without logging them as this copy's own changes.
 *
 * On the device, rows it changed again while the round was in flight are skipped: they are
 * newer than what the server sent and go up with the next push.
 */
export function applyChanges(db: Db, changes: RowChange[]): { applied: number; failed: ApplyFailure[] } {
  const pending = new Set(
    db.all<{ tbl: string; pk: string }>('SELECT DISTINCT tbl, pk FROM _changes').map(
      (row) => `${row.tbl}\u0000${row.pk}`
    )
  )
  return applyRows(
    db,
    changes.filter((change) => !pending.has(`${change.tbl}\u0000${change.pk}`))
  )
}

/**
 * Tables in the order a parent comes before its children, so an insert never points at a
 * row that has not arrived yet. Deletes run the other way round.
 */
function parentFirst(db: Db, tables: Map<string, TableInfo>): string[] {
  const parents = new Map<string, Set<string>>()
  for (const name of tables.keys()) {
    const references = db
      .all<{ table: string }>(`PRAGMA foreign_key_list(${quote(name)})`)
      .map((row) => row.table)
      .filter((parent) => parent !== name && tables.has(parent))
    parents.set(name, new Set(references))
  }

  const ordered: string[] = []
  const visiting = new Set<string>()
  const visit = (name: string): void => {
    if (ordered.includes(name) || visiting.has(name)) return
    visiting.add(name)
    for (const parent of parents.get(name) ?? []) visit(parent)
    visiting.delete(name)
    ordered.push(name)
  }
  for (const name of [...tables.keys()].sort()) visit(name)
  return ordered
}

function applyRows(
  db: Db,
  changes: RowChange[],
  afterEach?: (change: RowChange) => void
): { applied: number; failed: ApplyFailure[] } {
  const tables = tableMap(db)
  const order = parentFirst(db, tables)
  const rank = (name: string): number => order.indexOf(name)

  const upserts = changes
    .filter((change) => change.op === 'upsert')
    .sort((a, b) => rank(a.tbl) - rank(b.tbl))
  const deletes = changes
    .filter((change) => change.op === 'delete')
    .sort((a, b) => rank(b.tbl) - rank(a.tbl))

  const failed: ApplyFailure[] = []
  let applied = 0

  withoutLogging(db, () =>
    db.transaction(() => {
      for (const change of [...upserts, ...deletes]) {
        const table = tables.get(change.tbl)
        if (!table) {
          failed.push({ tbl: change.tbl, pk: change.pk, error: 'Unknown table on this copy.' })
          continue
        }
        if (isDeviceLocal(change)) continue

        // One savepoint per row: a row that breaks a constraint here is reported and
        // skipped, and must not take the rest of the round down with it.
        db.exec('SAVEPOINT sync_row')
        try {
          if (change.op === 'upsert') upsert(db, table, change)
          else remove(db, table, change.pk)
          afterEach?.(change)
          db.exec('RELEASE sync_row')
          applied += 1
        } catch (error) {
          db.exec('ROLLBACK TO sync_row')
          db.exec('RELEASE sync_row')
          failed.push({
            tbl: change.tbl,
            pk: change.pk,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }
    })
  )

  return { applied, failed }
}

function isDeviceLocal(change: RowChange): boolean {
  if (change.tbl !== 'settings') return false
  const [key] = JSON.parse(change.pk) as string[]
  return (DEVICE_LOCAL_SETTINGS as readonly string[]).includes(key ?? '')
}

/**
 * INSERT … ON CONFLICT DO UPDATE, never INSERT OR REPLACE: REPLACE deletes the old row
 * first, and that delete fires every ON DELETE CASCADE pointing at it — replacing a task
 * would wipe its plan blocks and dependencies.
 */
function upsert(db: Db, table: TableInfo, change: RowChange): void {
  const row = change.row ?? {}
  // Only columns this copy knows. Both sides are on the same schema version, so this is a
  // guard, not a feature.
  const columns = table.columns.filter((column) => column in row)
  const updates = columns.filter((column) => !table.pk.includes(column))

  const sql =
    `INSERT INTO ${quote(table.name)} (${columns.map(quote).join(', ')}) ` +
    `VALUES (${columns.map(() => '?').join(', ')}) ` +
    `ON CONFLICT (${table.pk.map(quote).join(', ')}) ` +
    (updates.length > 0
      ? `DO UPDATE SET ${updates.map((column) => `${quote(column)} = excluded.${quote(column)}`).join(', ')}`
      : 'DO NOTHING')

  db.run(
    sql,
    columns.map((column) => row[column] ?? null)
  )
}

function remove(db: Db, table: TableInfo, pk: string): void {
  const values = JSON.parse(pk) as Param[]
  const where = table.pk.map((column) => `${quote(column)} = ?`).join(' AND ')
  db.run(`DELETE FROM ${quote(table.name)} WHERE ${where}`, values)
}
