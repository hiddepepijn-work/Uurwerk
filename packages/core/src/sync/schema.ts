/**
 * ★ The change log every copy of the database keeps. ★
 *
 * The VPS holds the main copy; the laptop (and later the phone) each hold a full copy of
 * their own, so everything keeps working offline. What travels between them is not calls
 * but rows: a trigger on every table notes "this row changed" in `_changes`, and sync ships
 * the row as it is now.
 *
 * Why triggers and not the repositories: every writer in the app — twenty repositories,
 * the migrations' helpers, the attribution splitter — would have had to remember to log.
 * A trigger cannot forget.
 *
 * The triggers are dropped and recreated on every open, generated from the live schema.
 * A later migration that adds a column or rebuilds a table therefore needs no sync work:
 * the next open writes triggers for the table as it is now.
 */

import type { Db } from '../db/connection.js'

/**
 * Settings that describe this machine rather than the person: hotkeys, the capture loop,
 * how the window behaves. Syncing them would make the laptop's hotkeys the phone's.
 */
export const DEVICE_LOCAL_SETTINGS = [
  'hotkeys',
  'captureIntervalMin',
  'captureEnabled',
  'captureQuality',
  'captureBlocklist',
  'idleTimeoutMin',
  'resumeAfterIdle',
  'timelapseFps',
  'reportOutputDir',
  'autoLaunch',
  'startupBehaviour',
  'showMorningNotification',
  'closeToTray',
  'serverUrl',
  'focusShortcuts',
  'focusBlockedApps'
] as const

/** Epoch milliseconds, computed inside SQLite so a trigger can stamp a change. */
export const SQL_NOW_MS = `CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)`

const TRIGGER_PREFIX = '_sync_'

export interface TableInfo {
  name: string
  /** Primary-key columns, in key order. */
  pk: string[]
  columns: string[]
}

/** Creates the bookkeeping tables. Safe to call on every open. */
function ensureTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _changes (
      seq     INTEGER PRIMARY KEY AUTOINCREMENT,
      tbl     TEXT NOT NULL,
      -- JSON array of the primary-key values, written by SQLite's json_array() so every
      -- copy spells the same key the same way.
      pk      TEXT NOT NULL,
      op      TEXT NOT NULL CHECK (op IN ('upsert', 'delete')),
      at      INTEGER NOT NULL,
      -- Which device made the change. NULL = this copy itself.
      origin  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_changes_row ON _changes(tbl, pk);

    CREATE TABLE IF NOT EXISTS _sync_state (
      id              INTEGER PRIMARY KEY CHECK (id = 1),
      -- 1 while remote rows are being applied or migrations run: those are not new changes.
      applying        INTEGER NOT NULL DEFAULT 0,
      device_id       TEXT,
      -- Highest server seq this copy has pulled.
      last_pulled     INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO _sync_state (id) VALUES (1);
    -- Nothing is being applied while the database opens. A crash mid-apply would otherwise
    -- leave logging switched off for good, and every later edit would silently stay local.
    UPDATE _sync_state SET applying = 0 WHERE id = 1;
  `)
}

/** Every table that syncs: all user tables, none of the bookkeeping. */
export function syncedTables(db: Db): TableInfo[] {
  const names = db
    .all<{ name: string }>(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\'
        ORDER BY name`
    )
    .map((row) => row.name)

  return names.map((name) => {
    const info = db.all<{ name: string; pk: number }>(`PRAGMA table_info("${name}")`)
    return {
      name,
      columns: info.map((column) => column.name),
      pk: info
        .filter((column) => column.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((column) => column.name)
    }
  })
}

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`

function pkJson(table: TableInfo, alias: 'NEW' | 'OLD'): string {
  return `json_array(${table.pk.map((column) => `${alias}.${quote(column)}`).join(', ')})`
}

/** Settings rows for this machine only never enter the log. */
function whenClause(table: TableInfo, alias: 'NEW' | 'OLD'): string {
  const base = `(SELECT applying FROM _sync_state WHERE id = 1) = 0`
  if (table.name !== 'settings') return base
  const keys = DEVICE_LOCAL_SETTINGS.map((key) => `'${key}'`).join(', ')
  return `${base} AND ${alias}.key NOT IN (${keys})`
}

/** Drops and rewrites every sync trigger from the schema as it is now. */
export function installSync(db: Db): void {
  ensureTables(db)

  const existing = db.all<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '${TRIGGER_PREFIX}%'`
  )
  for (const trigger of existing) db.exec(`DROP TRIGGER IF EXISTS ${quote(trigger.name)}`)

  for (const table of syncedTables(db)) {
    // Every table in this schema has a primary key; one without could not be synced by row.
    if (table.pk.length === 0) continue
    const t = quote(table.name)

    for (const [event, alias, op] of [
      ['INSERT', 'NEW', 'upsert'],
      ['UPDATE', 'NEW', 'upsert'],
      ['DELETE', 'OLD', 'delete']
    ] as const) {
      db.exec(`
        CREATE TRIGGER ${quote(`${TRIGGER_PREFIX}${table.name}_${event.toLowerCase()}`)}
        AFTER ${event} ON ${t}
        WHEN ${whenClause(table, alias)}
        BEGIN
          INSERT INTO _changes (tbl, pk, op, at, origin)
          VALUES ('${table.name}', ${pkJson(table, alias)}, '${op}', ${SQL_NOW_MS}, NULL);
        END
      `)
    }
  }
}

/**
 * Runs fn with the triggers muted: applying rows that came from elsewhere, or a migration.
 *
 * A migration runs on every copy independently, so whatever it writes is already on each
 * of them — logging it would make every device send the other the same rows. That is also
 * why a migration must never insert rows under random ids: two copies would each invent
 * their own and sync would carry both.
 */
export function withoutLogging<T>(db: Db, fn: () => T): T {
  const hasState = db.get(
    `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = '_sync_state'`
  )
  if (!hasState) return fn()

  const before = db.get<{ applying: number }>('SELECT applying FROM _sync_state WHERE id = 1')
  db.run('UPDATE _sync_state SET applying = 1 WHERE id = 1')
  try {
    return fn()
  } finally {
    db.run('UPDATE _sync_state SET applying = ? WHERE id = 1', [before?.applying ?? 0])
  }
}
