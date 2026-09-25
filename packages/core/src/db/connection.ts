/**
 * Database handle and migration runner.
 *
 * node-sqlite3-wasm is used instead of better-sqlite3 on purpose: better-sqlite3 needs a
 * native compile (node-gyp -> Python + MSVC), which this machine does not have and which
 * would break the build on any fresh machine too. The WASM build is file-backed, fully
 * synchronous, and fast enough by orders of magnitude for a single user's time log.
 */

import * as sqlite3 from 'node-sqlite3-wasm'
import { MIGRATIONS } from './migrations/index.js'
import { installSync, withoutLogging } from '../sync/schema.js'

/**
 * node-sqlite3-wasm ships as CommonJS. A named import resolves fine once Rollup has bundled
 * the app, but breaks under a plain ESM loader (`tsx scripts/seed.ts`). Reading the class
 * off the namespace works in both, so the seed script and the app share one code path.
 */
type DatabaseCtor = typeof sqlite3.Database
const namespace = sqlite3 as unknown as {
  Database?: DatabaseCtor
  default?: { Database: DatabaseCtor }
}
const SqliteDatabase: DatabaseCtor = namespace.Database ?? namespace.default!.Database

/**
 * What Db needs from a SQLite driver. node-sqlite3-wasm (laptop, server) fits it as it is;
 * the phone wraps sql.js to fit it. Nothing above this line knows which one is underneath.
 */
export interface SqlDriver {
  all(sql: string, params?: never): unknown[]
  get(sql: string, params?: never): unknown
  run(sql: string, params?: never): { changes: number }
  exec(sql: string): void
  readonly inTransaction: boolean
  close(): void
}

export type Row = Record<string, string | number | bigint | Uint8Array | null>
export type Param = string | number | boolean | null

/** Thin typed wrapper. Repositories talk to this, never to the driver directly. */
export class Db {
  constructor(private readonly raw: SqlDriver) {}

  all<T = Row>(sql: string, params: Param[] = []): T[] {
    return this.raw.all(sql, params as never) as T[]
  }

  get<T = Row>(sql: string, params: Param[] = []): T | null {
    return (this.raw.get(sql, params as never) ?? null) as T | null
  }

  run(sql: string, params: Param[] = []): { changes: number } {
    const result = this.raw.run(sql, params as never)
    return { changes: result.changes }
  }

  exec(sql: string): void {
    this.raw.exec(sql)
  }

  /** True while a transaction is open — used to keep nested calls from starting a second. */
  get inTransaction(): boolean {
    return this.raw.inTransaction
  }

  /**
   * Runs fn inside a transaction, rolling back on any throw.
   *
   * Re-entrant on purpose: SQLite has no nested transactions, and services compose — for
   * example blockAndSwitch calls switchTask, and both want atomicity. An inner call joins
   * the transaction already in progress, so a failure anywhere still rolls the whole
   * operation back, and only the outermost caller commits.
   */
  transaction<T>(fn: () => T): T {
    if (this.raw.inTransaction) return fn()

    this.raw.exec('BEGIN')
    try {
      const result = fn()
      this.raw.exec('COMMIT')
      return result
    } catch (error) {
      this.raw.exec('ROLLBACK')
      throw error
    }
  }

  close(): void {
    this.raw.close()
  }
}

/**
 * Opens (creating if needed) the database at `filename` and brings the schema up to date.
 * Pass ':memory:' for tests.
 */
export function openDatabase(filename: string): Db {
  return openDatabaseWith(new SqliteDatabase(filename) as unknown as SqlDriver)
}

/** Same as openDatabase, over a driver that is already open — the phone's sql.js. */
export function openDatabaseWith(raw: SqlDriver): Db {
  const db = new Db(raw)

  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA synchronous = NORMAL')

  // Migrations run on every copy by themselves, so what they write is not a change to sync.
  // The triggers are rewritten afterwards from the schema the migrations left behind.
  withoutLogging(db, () => runMigrations(db))
  installSync(db)
  return db
}

export function runMigrations(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id       INTEGER PRIMARY KEY,
      name     TEXT NOT NULL,
      applied  INTEGER NOT NULL
    )
  `)

  const applied = new Set(db.all<{ id: number }>('SELECT id FROM _migrations').map((r) => r.id))

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue

    // A table rebuild has to run with foreign keys off, and the pragma only takes effect
    // outside a transaction. See Migration.rebuildsTable.
    if (migration.rebuildsTable) db.exec('PRAGMA foreign_keys = OFF')

    try {
      // Schema and data move together: if the data step throws, the schema change is
      // rolled back too and the database stays on the previous version rather than
      // half-migrated.
      db.transaction(() => {
        if (migration.sql) db.exec(migration.sql)
        if (migration.run) migration.run(db)

        if (migration.rebuildsTable) {
          const broken = db.all('PRAGMA foreign_key_check')
          if (broken.length > 0) {
            throw new Error(
              `Migration ${migration.id} (${migration.name}) left ${broken.length} broken foreign key reference(s).`
            )
          }
        }

        db.run('INSERT INTO _migrations (id, name, applied) VALUES (?, ?, ?)', [
          migration.id,
          migration.name,
          Date.now()
        ])
      })
    } finally {
      if (migration.rebuildsTable) db.exec('PRAGMA foreign_keys = ON')
    }
  }
}

/** Stable ids everywhere. */
export function newId(): string {
  return crypto.randomUUID()
}

/** SQLite has no boolean type; these two keep the conversion in one place. */
export const toDbBool = (value: boolean): number => (value ? 1 : 0)
export const fromDbBool = (value: unknown): boolean => value === 1 || value === true
