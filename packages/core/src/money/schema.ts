/**
 * ★ Geld's tables, outside the migrations on purpose. ★
 *
 * Every table starts with an underscore, and underscore tables are never given sync triggers
 * (sync/schema.ts, syncedTables): what you earn and spend never reaches the VPS in the clear.
 *
 * They are created here and not in a migration because a migration raises the schema version,
 * and every sync round refuses when the device and the server disagree on it. These tables are
 * not part of the shared schema — they live on this copy only — so bumping that version would
 * break syncing on laptop and phone for nothing until the server and the iPhone app caught up.
 *
 * IF NOT EXISTS makes this safe to run on every open. A later change to a table goes here as
 * an idempotent step (check the column, then ALTER), never by editing the CREATE.
 */

import type { Db } from '../db/connection.js'

export const MONEY_TABLES = [
  '_geld_incomes',
  '_geld_costs',
  '_geld_phases',
  '_geld_goals',
  '_geld_milestones',
  '_geld_entries',
  '_geld_shifts',
  '_geld_profiles',
  '_geld_closings',
  '_geld_accounts',
  '_geld_transactions',
  '_geld_rules'
] as const

export function ensureMoneySchema(db: Db): void {
  db.exec(/* sql */ `
    CREATE TABLE IF NOT EXISTS _geld_incomes (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      kind         TEXT NOT NULL CHECK (kind IN ('fixed', 'weekly', 'shifts', 'open')),
      amount_cents INTEGER,
      day          INTEGER,
      from_date    TEXT,
      until_date   TEXT,
      updated_at   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS _geld_costs (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      category     TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      day          INTEGER NOT NULL,
      from_date    TEXT,
      until_date   TEXT,
      updated_at   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS _geld_phases (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      from_date    TEXT NOT NULL,
      until_date   TEXT NOT NULL,
      budget_cents INTEGER NOT NULL,
      -- NULL: everything left over goes to the goal.
      saving_cents INTEGER,
      updated_at   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS _geld_goals (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      on_account_cents INTEGER NOT NULL,
      start_cents      INTEGER NOT NULL,
      date             TEXT NOT NULL,
      updated_at       INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS _geld_milestones (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      date         TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      paid         INTEGER NOT NULL DEFAULT 0,
      updated_at   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS _geld_entries (
      id           TEXT PRIMARY KEY,
      date         TEXT NOT NULL,
      kind         TEXT NOT NULL CHECK (kind IN ('spend', 'saving', 'extra', 'shiftPay')),
      amount_cents INTEGER NOT NULL,
      note         TEXT NOT NULL DEFAULT '',
      category     TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS _geld_entries_date ON _geld_entries(date);
    CREATE TABLE IF NOT EXISTS _geld_shifts (
      id         TEXT PRIMARY KEY,
      date       TEXT NOT NULL,
      template   TEXT NOT NULL,
      status     TEXT NOT NULL CHECK (status IN ('planned', 'worked')),
      updated_at INTEGER NOT NULL
    );
    -- One JSON document per profile: premiums and templates are read and written whole.
    CREATE TABLE IF NOT EXISTS _geld_profiles (
      id         TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    -- The bank (Enable Banking, read-only). Balances and transactions travel through the vault
    -- like everything else, so the phone sees what the laptop fetched.
    CREATE TABLE IF NOT EXISTS _geld_accounts (
      uid           TEXT PRIMARY KEY,
      iban          TEXT NOT NULL,
      name          TEXT NOT NULL,
      role          TEXT NOT NULL CHECK (role IN ('betaal', 'spaar', 'other')),
      locked_until  TEXT,
      balance_cents INTEGER,
      balance_date  TEXT,
      updated_at    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS _geld_transactions (
      id            TEXT PRIMARY KEY,
      account_uid   TEXT NOT NULL,
      date          TEXT NOT NULL,
      amount_cents  INTEGER NOT NULL,
      counterparty  TEXT NOT NULL DEFAULT '',
      counter_iban  TEXT,
      description   TEXT NOT NULL DEFAULT '',
      pending       INTEGER NOT NULL DEFAULT 0,
      kind          TEXT,
      ref_id        TEXT,
      manual        INTEGER NOT NULL DEFAULT 0,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS _geld_transactions_date ON _geld_transactions(date);
    CREATE TABLE IF NOT EXISTS _geld_rules (
      id         TEXT PRIMARY KEY,
      pattern    TEXT NOT NULL,
      kind       TEXT NOT NULL,
      ref_id     TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS _geld_closings (
      month             TEXT PRIMARY KEY,
      saving_cents      INTEGER NOT NULL,
      from_extra_cents  INTEGER NOT NULL,
      extra_cents       INTEGER NOT NULL,
      budget_left_cents INTEGER NOT NULL,
      closed_at         INTEGER NOT NULL
    );
  `)
  installOutbox(db)
}

/** Milliseconds since 1970 in SQLite, for the outbox triggers. */
const NOW_MS = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)"

/**
 * The outbox for the encrypted sync (money/vault.ts): every insert, update and delete on a
 * Geld table queues the row, unless the vault itself is applying rows from the server
 * (`applying` set), so nothing is sent straight back.
 */
function installOutbox(db: Db): void {
  db.exec(/* sql */ `
    CREATE TABLE IF NOT EXISTS _geld_outbox (
      tbl TEXT NOT NULL,
      id  TEXT NOT NULL,
      at  INTEGER NOT NULL,
      PRIMARY KEY (tbl, id)
    );
    CREATE TABLE IF NOT EXISTS _geld_sync_state (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
  `)
  const when = "NOT EXISTS (SELECT 1 FROM _geld_sync_state WHERE k = 'applying')"
  for (const table of MONEY_TABLES) {
    const pk = table === '_geld_closings' ? 'month' : table === '_geld_accounts' ? 'uid' : 'id'
    for (const [op, row] of [['INSERT', 'NEW'], ['UPDATE', 'NEW'], ['DELETE', 'OLD']] as const) {
      // Not INSERT OR REPLACE: inside a trigger SQLite lets the outer statement's conflict
      // rule win, and an outer upsert turns OR REPLACE into an abort ("UNIQUE constraint
      // failed: _geld_outbox") the second time a row is saved. A trigger-level upsert has no
      // such override. Dropped and made again on every open, so a copy with the first version
      // gets this one.
      const name = `${table}_out_${op.toLowerCase()}`
      db.exec(`DROP TRIGGER IF EXISTS ${name}`)
      db.exec(
        `CREATE TRIGGER ${name} AFTER ${op} ON ${table} WHEN ${when}
         BEGIN
           INSERT INTO _geld_outbox (tbl, id, at) VALUES ('${table}', ${row}.${pk}, ${NOW_MS})
           ON CONFLICT (tbl, id) DO UPDATE SET at = excluded.at;
         END`
      )
    }
  }
}

/**
 * Wipes Geld from a copy of the database file before it leaves this machine (the pairing
 * snapshot). Dropping alone would leave the rows in freed pages, so the copy is vacuumed too.
 */
export function wipeMoneyFromCopy(db: Db, file: string): void {
  const path = file.replace(/\\/g, '/').replace(/'/g, "''")
  db.exec(`ATTACH DATABASE '${path}' AS outgoing`)
  try {
    const tables = db
      .all<{ name: string }>("SELECT name FROM outgoing.sqlite_master WHERE type = 'table'")
      .filter(({ name }) => name.startsWith('_geld_'))
    for (const { name } of tables) db.exec(`DROP TABLE outgoing."${name.replace(/"/g, '""')}"`)
    db.exec('VACUUM outgoing')
  } finally {
    db.exec('DETACH DATABASE outgoing')
  }
}
