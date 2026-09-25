/**
 * The phone's copy of the database.
 *
 * sql.js is SQLite compiled to WebAssembly, the same engine as the laptop's, running in the
 * app's web view. It works on a copy in memory; this file writes that copy to the app's
 * private Data directory shortly after every change and whenever the app goes to the
 * background, and reads it back at start. iOS backs that directory up and never purges it.
 */

import { Filesystem, Directory } from '@capacitor/filesystem'
import initSqlJs, { type Database } from 'sql.js'
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url'

import type { SqlDriver } from '@core/db/index.js'

const FILE = 'uurwerk.db'
const INCOMING = 'uurwerk.incoming.db'
const SAVE_AFTER_MS = 800

type Param = string | number | boolean | null | undefined | Uint8Array

const bindable = (params: unknown): Array<string | number | null | Uint8Array> =>
  ((params as Param[] | undefined) ?? []).map((value) =>
    value === undefined ? null : typeof value === 'boolean' ? (value ? 1 : 0) : value
  )

/** sql.js shaped to what core's Db expects of a driver. */
class SqlJsDriver implements SqlDriver {
  private transaction = false

  constructor(
    readonly db: Database,
    private readonly changed: () => void
  ) {}

  all(sql: string, params?: never): unknown[] {
    const statement = this.db.prepare(sql)
    try {
      statement.bind(bindable(params))
      const rows: unknown[] = []
      while (statement.step()) rows.push(statement.getAsObject())
      return rows
    } finally {
      statement.free()
    }
  }

  get(sql: string, params?: never): unknown {
    return this.all(sql, params)[0] ?? null
  }

  run(sql: string, params?: never): { changes: number } {
    this.db.run(sql, bindable(params))
    const changes = this.db.getRowsModified()
    this.changed()
    return { changes }
  }

  exec(sql: string): void {
    this.db.exec(sql)
    // sql.js cannot say whether a transaction is open, so the wrapper keeps count of the
    // only three statements that change it. A SAVEPOINT's ROLLBACK TO does not.
    if (/^\s*BEGIN\b/i.test(sql)) this.transaction = true
    else if (/^\s*(COMMIT|END)\b/i.test(sql) || /^\s*ROLLBACK\s*;?\s*$/i.test(sql)) {
      this.transaction = false
    }
    this.changed()
  }

  get inTransaction(): boolean {
    return this.transaction
  }

  close(): void {
    this.db.close()
  }
}

export interface PhoneDatabase {
  driver: SqlDriver
  /** Writes the copy to disk now, e.g. when the app is sent to the background. */
  flush(): Promise<void>
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

export async function openPhoneDatabase(): Promise<PhoneDatabase> {
  console.info('[db] init')
  const SQL = await initSqlJs({ locateFile: () => wasmUrl })

  // A copy downloaded while pairing is waiting to replace this one.
  const incoming = await readBytes(INCOMING)
  if (incoming) {
    await writeBytes(FILE, incoming)
    await Filesystem.deleteFile({ path: INCOMING, directory: Directory.Data })
  }

  console.info('[db] read')
  const bytes = await readBytes(FILE)
  const db = bytes ? new SQL.Database(bytes) : new SQL.Database()
  let driver: SqlJsDriver | null = null

  const flush = async (): Promise<void> => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    if (!driver || driver.inTransaction) return
    const data = db.export()
    // export() resets connection-level pragmas; the foreign keys have to come back on.
    db.exec('PRAGMA foreign_keys = ON')
    await writeBytes(FILE, data)
  }

  driver = new SqlJsDriver(db, () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => void flush(), SAVE_AFTER_MS)
  })

  return { driver, flush }
}

/** Puts a copy from the server beside the database; it replaces it at the next start. */
export async function stageIncoming(bytes: Uint8Array): Promise<void> {
  await writeBytes(INCOMING, bytes)
}

// ---------------------------------------------------------------- files

async function readBytes(path: string): Promise<Uint8Array | null> {
  try {
    const { data } = await Filesystem.readFile({ path, directory: Directory.Data })
    if (typeof data !== 'string') return new Uint8Array(await data.arrayBuffer())
    return fromBase64(data)
  } catch {
    return null
  }
}

async function writeBytes(path: string, bytes: Uint8Array): Promise<void> {
  await Filesystem.writeFile({ path, directory: Directory.Data, data: toBase64(bytes) })
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}
