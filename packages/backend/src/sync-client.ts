/**
 * ★ The device end of sync. ★
 *
 * The laptop keeps its own full copy of the database and works on it, online or not. This
 * client carries the difference to the VPS and back:
 *
 *   - a round (push + pull) every half minute, and soon after anything changes locally
 *   - the screenshot files, which the rows point at but do not contain
 *   - the handful of actions only the server can do (calendar sync, publishing), which
 *     are forwarded when online and refused with a clear sentence when not
 *
 * Offline is the normal case this is built around, not an error: a failed round leaves
 * everything in `_changes`, and the next round that gets through carries all of it.
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { tmpdir } from 'node:os'

import type { SyncStatus } from '@core/contract/api.js'
import type { MoneyVaultStatus } from '@core/contract/types.js'
import { wipeMoneyFromCopy } from '@core/money/schema.js'
import { MoneyVault, type VaultTransport } from '@core/money/vault.js'
import {
  acknowledge,
  adoptSnapshot,
  applyChanges,
  deviceId,
  lastPulled,
  pendingChanges,
  schemaVersion,
  setLastPulled,
  type Feed,
  type ReceiveResult,
  type RowChange
} from '@core/sync/engine.js'

import { invalidatedDomains } from './announce.js'
import type { Backend } from './create.js'
import { emitEvent, host, type SecretKey } from './host.js'
import { log } from './log.js'
import { watchServer } from '@core/sync/live.js'

const ROUND_EVERY_MS = 30_000
/** How long after a local edit the next round starts: soon, but not once per keystroke. */
const SETTLE_MS = 2_000
/** How long after the server announces a change the pull starts: a burst of edits is one pull. */
const PULL_MS = 250
const TIMEOUT_MS = 30_000
/** Screenshots per round, so a backlog after a week offline does not block the rows. */
const FILES_PER_ROUND = 40

export { SERVER_ONLY, isServerOnly } from './server-only.js'

interface SyncResponse {
  received: ReceiveResult
  feed: Feed
}

export class SyncClient {
  private timer: NodeJS.Timeout | null = null
  private settleTimer: NodeJS.Timeout | null = null
  private pullTimer: NodeJS.Timeout | null = null
  private stopLive: (() => void) | null = null
  private running: Promise<void> | null = null
  private online = false
  private lastSyncAt: number | null = null
  private lastError: string | null = null
  private secretsHandedOver = false
  private readonly moneyVault: MoneyVault
  private moneySyncAt: number | null = null
  private moneyError: string | null = null

  constructor(
    private readonly backend: Backend,
    private readonly dbPath: string
  ) {
    this.moneyVault = new MoneyVault(backend.store.db)
    backend.store.db.exec(`
      CREATE TABLE IF NOT EXISTS _uploaded_files (
        artifact_id TEXT PRIMARY KEY,
        uploaded_at INTEGER NOT NULL
      )
    `)
  }

  // ------------------------------------------------------------ lifecycle

  get paired(): boolean {
    return Boolean(this.serverUrl() && host().secrets.get('deviceToken'))
  }

  start(): void {
    this.stop()
    if (!this.paired) return
    this.timer = setInterval(() => void this.round(), ROUND_EVERY_MS)
    void this.round()
    // Instant: pull as soon as the server says something changed (another device, Jarvis).
    this.stopLive = watchServer(this.serverUrl(), host().secrets.get('deviceToken') ?? '', () => this.pull())
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.settleTimer) clearTimeout(this.settleTimer)
    if (this.pullTimer) clearTimeout(this.pullTimer)
    this.stopLive?.()
    this.timer = null
    this.settleTimer = null
    this.pullTimer = null
    this.stopLive = null
  }

  /** The server announced a change: fetch it now, once for a burst. */
  private pull(): void {
    if (this.pullTimer) return
    this.pullTimer = setTimeout(() => {
      this.pullTimer = null
      void this.round()
    }, PULL_MS)
  }

  /** Something changed locally: sync soon. Cheap to call on every write. */
  nudge(): void {
    if (!this.paired || this.settleTimer) return
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null
      void this.round()
    }, SETTLE_MS)
  }

  status(): SyncStatus {
    const db = this.backend.store.db
    const pending = db.get<{ n: number }>('SELECT COUNT(DISTINCT tbl || pk) AS n FROM _changes')?.n ?? 0
    return {
      paired: this.paired,
      serverUrl: this.serverUrl(),
      deviceId: deviceId(db),
      online: this.online,
      pending,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError
    }
  }

  // ---------------------------------------------------------------- round

  /** One round. Concurrent callers share the round in flight rather than starting another. */
  round(): Promise<void> {
    if (!this.paired) return Promise.resolve()
    this.running ??= this.runRound().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async runRound(): Promise<void> {
    const db = this.backend.store.db
    try {
      const { changes, upTo } = pendingChanges(db)
      const response = await this.request<SyncResponse>('POST', '/api/sync', {
        schema: schemaVersion(db),
        since: lastPulled(db),
        changes
      })

      acknowledge(db, upTo)
      for (const failure of response.received.failed) {
        log.warn('The server refused a row.', failure)
      }

      const applied = applyChanges(db, response.feed.changes)
      setLastPulled(db, response.feed.seq)
      for (const failure of applied.failed) log.warn('A row from the server did not apply.', failure)

      if (applied.applied > 0) this.announce(response.feed.changes)
      await this.uploadFiles()
      await this.moneyRound()

      this.online = true
      this.lastError = null
      this.lastSyncAt = Date.now()

      if (!this.secretsHandedOver) {
        await this.handOverCalendarSecrets()
        this.secretsHandedOver = true
      }
    } catch (error) {
      this.online = false
      this.lastError = error instanceof Error ? error.message : String(error)
      // Offline is expected; only a real refusal is worth more than a line in the log.
      log.info('Sync round did not complete; changes stay queued.', this.lastError)
    }
  }

  // ------------------------------------------------------------ Geld

  private readonly vaultTransport: VaultTransport = {
    get: (since) => this.request('GET', `/api/geld/vault?since=${since}`),
    post: (body) => this.request('POST', '/api/geld/vault', body)
  }

  /**
   * Geld's part of a round: sealed records out, sealed records in (core/money/vault.ts). Its own
   * error, so a problem here never holds up the rest of the sync.
   */
  private async moneyRound(): Promise<void> {
    const key = host().secrets.get('geldKey')
    if (!key) return
    try {
      const result = await this.moneyVault.round(key, this.vaultTransport)
      if (result.applied > 0) emitEvent('data:invalidated', { domain: 'money' })
      this.moneySyncAt = Date.now()
      this.moneyError = null
    } catch (error) {
      this.moneyError = error instanceof Error ? error.message : String(error)
      log.info('Geld did not sync this round.', this.moneyError)
    }
  }

  vaultStatus(): MoneyVaultStatus {
    return {
      enabled: Boolean(host().secrets.get('geldKey')),
      paired: this.paired,
      lastSyncAt: this.moneySyncAt,
      lastError: this.moneyError,
      pending: this.moneyVault.pending()
    }
  }

  async vaultSetup(passphrase: string): Promise<MoneyVaultStatus> {
    if (!this.paired) throw new Error('Koppel dit apparaat eerst aan de server (Instellingen → Sync).')
    const key = await this.moneyVault.setup(passphrase, this.vaultTransport)
    host().secrets.set('geldKey', key)
    await this.moneyRound()
    return this.vaultStatus()
  }

  vaultForget(): MoneyVaultStatus {
    host().secrets.set('geldKey', '')
    this.moneyVault.forget()
    this.moneySyncAt = null
    this.moneyError = null
    return this.vaultStatus()
  }

  /** Tells the screens which parts of the data moved underneath them. */
  private announce(changes: RowChange[]): void {
    for (const domain of invalidatedDomains(new Set(changes.map((change) => change.tbl)))) {
      emitEvent('data:invalidated', { domain })
    }
  }

  /**
   * Screenshot and timelapse files the server does not have yet.
   *
   * The row travels with sync; the bytes travel here, under the artifact's id. A file the
   * laptop already deleted (retention, or you removed the frame) is simply skipped.
   */
  private async uploadFiles(): Promise<void> {
    const db = this.backend.store.db
    const waiting = db.all<{ id: string; path: string }>(
      `SELECT id, path FROM artifacts
        WHERE id NOT IN (SELECT artifact_id FROM _uploaded_files)
        ORDER BY captured_at DESC LIMIT ?`,
      [FILES_PER_ROUND]
    )

    for (const artifact of waiting) {
      if (!existsSync(artifact.path)) {
        db.run('INSERT OR IGNORE INTO _uploaded_files (artifact_id, uploaded_at) VALUES (?, ?)', [
          artifact.id,
          Date.now()
        ])
        continue
      }
      const bytes = readFileSync(artifact.path)
      await this.request(
        'PUT',
        `/api/files/${encodeURIComponent(artifact.id)}${extname(artifact.path).toLowerCase()}`,
        bytes
      )
      db.run('INSERT OR IGNORE INTO _uploaded_files (artifact_id, uploaded_at) VALUES (?, ?)', [
        artifact.id,
        Date.now()
      ])
    }
  }

  /**
   * The calendar links and app passwords, for the server.
   *
   * Paired, the server is the one that syncs calendars — but the credentials were stored
   * in this laptop's Windows vault, which the server cannot read. Once per start, anything
   * the server is missing goes over the (TLS) sync connection into the server's own vault.
   * Nothing is sent that the server already has.
   */
  private async handOverCalendarSecrets(): Promise<void> {
    for (const account of this.backend.store.calendar.accounts()) {
      const key: SecretKey = account.provider === 'icloud' ? `icloud:${account.id}` : `ics:${account.id}`
      const value = host().secrets.get(key)
      if (!value) continue
      const present = await this.request<boolean>('POST', '/api/rpc/settings/hasSecret', [key])
      if (present) continue
      await this.request('POST', '/api/rpc/settings/setSecret', [key, value])
      log.info('Handed a calendar credential to the server.', { account: account.displayName })
    }
  }

  // -------------------------------------------------------------- pairing

  /** Asks the server about itself before anything is linked. */
  async probe(serverUrl: string, token: string): Promise<{ initialized: boolean; schema: number; device: string }> {
    return this.request('GET', '/api/sync/status', undefined, { serverUrl, token })
  }

  /**
   * Links this device.
   *
   * `upload`: the server is empty and this copy becomes its data — the move from laptop-only
   * to the VPS. `download`: the server has data and this copy is replaced by it; the file is
   * put beside the database and swapped in at the next start, because the open database
   * cannot be replaced underneath the running app.
   */
  async pair(serverUrl: string, token: string, mode: 'upload' | 'download'): Promise<SyncStatus> {
    const url = normaliseUrl(serverUrl)
    const server = await this.probe(url, token)
    const db = this.backend.store.db

    if (server.schema !== schemaVersion(db)) {
      throw new Error(
        `The server is on database version ${server.schema}, this app on ${schemaVersion(db)}. Update the older of the two first.`
      )
    }

    if (mode === 'upload') {
      if (server.initialized) {
        throw new Error('The server already holds data. Choose "download" to use the server’s copy instead.')
      }
      const file = join(tmpdir(), `uurwerk-upload-${Date.now()}.db`)
      try {
        db.exec(`VACUUM INTO '${file.replace(/\\/g, '/').replace(/'/g, "''")}'`)
        // Geld stays on this machine: the copy for the server leaves without it.
        wipeMoneyFromCopy(db, file)
        const { seq } = await this.request<{ seq: number }>(
          'PUT',
          '/api/sync/snapshot',
          readFileSync(file),
          { serverUrl: url, token }
        )
        adoptSnapshot(db, server.device, seq)
      } finally {
        rmSync(file, { force: true })
      }
    } else {
      if (!server.initialized) {
        throw new Error('The server is still empty. Choose "upload" to send this copy first.')
      }
      const { bytes, seq } = await this.download(url, token)
      writeFileSync(`${this.dbPath}.incoming`, bytes)
      writeFileSync(`${this.dbPath}.incoming.json`, JSON.stringify({ device: server.device, seq }))
    }

    host().secrets.set('deviceToken', token)
    this.backend.store.settings.update({ serverUrl: url })
    log.info('Paired with the server.', { url, mode, device: server.device })

    if (mode === 'download') {
      await host().relaunch()
    } else {
      this.start()
    }
    return this.status()
  }

  unpair(): SyncStatus {
    this.stop()
    host().secrets.set('deviceToken', '')
    this.backend.store.settings.update({ serverUrl: '' })
    log.info('Unpaired from the server; this copy stands alone again.')
    return this.status()
  }

  private async download(serverUrl: string, token: string): Promise<{ bytes: Buffer; seq: number }> {
    const response = await this.fetch('GET', `${serverUrl}/api/sync/snapshot`, token)
    const seq = Number(response.headers.get('X-Uurwerk-Seq') ?? '0')
    return { bytes: Buffer.from(await response.arrayBuffer()), seq }
  }

  // ------------------------------------------------------------ forwarding

  /** Runs a server-only action on the server, then pulls what it changed. */
  async forward(domain: string, method: string, args: unknown[]): Promise<unknown> {
    let result: unknown
    try {
      // Push first, so the server acts on what this copy already knows.
      await this.round()
      result = await this.request('POST', `/api/rpc/${domain}/${method}`, args)
    } catch (error) {
      if (!this.online) {
        throw new Error('This needs the server, and the server cannot be reached right now. Try again when online.')
      }
      throw error
    }
    await this.round()
    return result
  }

  // ----------------------------------------------------------------- HTTP

  private serverUrl(): string {
    return this.backend.store.settings.get().serverUrl
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    override?: { serverUrl: string; token: string }
  ): Promise<T> {
    const base = override?.serverUrl ?? this.serverUrl()
    const token = override?.token ?? host().secrets.get('deviceToken') ?? ''
    const response = await this.fetch(method, `${base}${path}`, token, body)
    const text = await response.text()
    return (text ? JSON.parse(text) : null) as T
  }

  private async fetch(
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    token: string,
    body?: unknown
  ): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    const binary = body instanceof Buffer

    try {
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined
            ? {}
            : { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' })
        },
        ...(body === undefined
          ? {}
          : {
              body: binary
                ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
                : JSON.stringify(body)
            }),
        signal: controller.signal
      })
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300)
        throw new Error(
          response.status === 401
            ? 'The server does not accept this device token.'
            : `${method} ${new URL(url).pathname} failed: ${response.status} ${detail}`
        )
      }
      return response
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`The server did not answer within ${TIMEOUT_MS / 1000} seconds.`)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}

function normaliseUrl(value: string): string {
  const url = value.trim().replace(/\/+$/, '')
  if (!/^https:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(url)) {
    // The device token and every row of your data go over this connection.
    throw new Error('The server address must start with https:// (plain http only for localhost).')
  }
  return url
}

/**
 * Swaps in a database downloaded by `pair(…, 'download')`. Called at startup, before the
 * database is opened. The replaced file is kept beside it, so nothing is ever thrown away.
 */
export function swapInDownloadedCopy(dbPath: string): void {
  const incoming = `${dbPath}.incoming`
  const meta = `${incoming}.json`
  if (!existsSync(incoming) || !existsSync(meta)) return

  const { device, seq } = JSON.parse(readFileSync(meta, 'utf8')) as { device: string; seq: number }
  if (existsSync(dbPath)) renameSync(dbPath, `${dbPath}.before-pairing-${Date.now()}`)
  renameSync(incoming, dbPath)
  rmSync(meta, { force: true })
  pendingAdoption = { device, seq }
  log.info('Swapped in the copy downloaded from the server.')
}

let pendingAdoption: { device: string; seq: number } | null = null

/** After a swap: turns the server's file into this device's copy. */
export function finishAdoption(backend: Backend): void {
  if (!pendingAdoption) return
  adoptSnapshot(backend.store.db, pendingAdoption.device, pendingAdoption.seq)
  // Every frame on the server came from somewhere; none of them need uploading from here.
  backend.store.db.run(
    'INSERT OR IGNORE INTO _uploaded_files (artifact_id, uploaded_at) SELECT id, ? FROM artifacts',
    [Date.now()]
  )
  pendingAdoption = null
}
