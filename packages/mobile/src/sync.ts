/**
 * The phone end of sync — the same rounds as the laptop's SyncClient, without the parts a
 * phone has no use for: it takes no screenshots, so it uploads no files, and it only ever
 * joins a server that already has data, so pairing is always a download.
 *
 * Offline is normal here too: a round that does not get through leaves the changes queued.
 */

import { Preferences } from '@capacitor/preferences'

import type { SyncStatus } from '@core/contract/api.js'
import type { MoneyVaultStatus } from '@core/contract/types.js'
import { MoneyVault, type VaultTransport } from '@core/money/vault.js'
import type { Db } from '@core/db/index.js'
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
  type ReceiveResult
} from '@core/sync/engine.js'

import { stageIncoming } from './database.js'
import { watchServer } from '@core/sync/live.js'

const ROUND_EVERY_MS = 30_000
const SETTLE_MS = 2_000
/** How long after the server announces a change the pull starts: a burst of edits is one pull. */
const PULL_MS = 250
const TIMEOUT_MS = 30_000

const KEY_URL = 'serverUrl'
const KEY_TOKEN = 'deviceToken'
const KEY_ADOPT = 'adoptAfterSwap'
/** The Geld key (money/vault.ts). In Preferences: the app's own sandbox, like the device token. */
const KEY_GELD = 'geldKey'

export class PhoneSync {
  private timer: ReturnType<typeof setInterval> | null = null
  private settle: ReturnType<typeof setTimeout> | null = null
  private pullTimer: ReturnType<typeof setTimeout> | null = null
  private stopLive: (() => void) | null = null
  private running: Promise<void> | null = null
  private online = false
  private lastSyncAt: number | null = null
  private lastError: string | null = null
  private url = ''
  private token = ''
  private geldKey = ''
  private moneySyncAt: number | null = null
  private moneyError: string | null = null
  private readonly moneyVault: MoneyVault

  constructor(
    private readonly db: Db,
    private readonly announce: (tables: Set<string>) => void
  ) {
    this.moneyVault = new MoneyVault(db)
  }

  /** Reads the stored link, finishes a pending download, starts the rounds. */
  async start(): Promise<void> {
    this.url = (await Preferences.get({ key: KEY_URL })).value ?? ''
    this.token = (await Preferences.get({ key: KEY_TOKEN })).value ?? ''
    this.geldKey = (await Preferences.get({ key: KEY_GELD })).value ?? ''

    const adopt = (await Preferences.get({ key: KEY_ADOPT })).value
    if (adopt) {
      const { device, seq } = JSON.parse(adopt) as { device: string; seq: number }
      adoptSnapshot(this.db, device, seq)
      await Preferences.remove({ key: KEY_ADOPT })
    }

    if (!this.paired) return
    this.timer = setInterval(() => void this.round(), ROUND_EVERY_MS)
    void this.round()
    this.listen()
  }

  /**
   * Instant: pull as soon as the server says something changed. iOS cuts the connection when
   * the app goes to the background, so main.tsx calls quiet() on pause and listen() on resume.
   */
  listen(): void {
    if (!this.paired || this.stopLive) return
    this.stopLive = watchServer(this.url, this.token, () => {
      if (this.pullTimer) return
      this.pullTimer = setTimeout(() => {
        this.pullTimer = null
        void this.round()
      }, PULL_MS)
    })
  }

  quiet(): void {
    this.stopLive?.()
    this.stopLive = null
  }

  get paired(): boolean {
    return Boolean(this.url && this.token)
  }

  nudge(): void {
    if (!this.paired || this.settle) return
    this.settle = setTimeout(() => {
      this.settle = null
      void this.round()
    }, SETTLE_MS)
  }

  status(): SyncStatus {
    const pending = this.db.get<{ n: number }>('SELECT COUNT(DISTINCT tbl || pk) AS n FROM _changes')?.n ?? 0
    return {
      paired: this.paired,
      serverUrl: this.url,
      deviceId: deviceId(this.db),
      online: this.online,
      pending,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError
    }
  }

  round(): Promise<void> {
    if (!this.paired) return Promise.resolve()
    this.running ??= this.runRound().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async runRound(): Promise<void> {
    try {
      const { changes, upTo } = pendingChanges(this.db)
      const response = await this.json<{ received: ReceiveResult; feed: Feed }>('POST', '/api/sync', {
        schema: schemaVersion(this.db),
        since: lastPulled(this.db),
        changes
      })
      acknowledge(this.db, upTo)
      const applied = applyChanges(this.db, response.feed.changes)
      setLastPulled(this.db, response.feed.seq)
      if (applied.applied > 0) {
        this.announce(new Set(response.feed.changes.map((change) => change.tbl)))
      }
      await this.moneyRound()
      this.online = true
      this.lastError = null
      this.lastSyncAt = Date.now()
    } catch (error) {
      this.online = false
      this.lastError = error instanceof Error ? error.message : String(error)
    }
  }

  // ------------------------------------------------------------ Geld

  private readonly vaultTransport: VaultTransport = {
    get: (since) => this.json('GET', `/api/geld/vault?since=${since}`),
    post: (body) => this.json('POST', '/api/geld/vault', body)
  }

  /** Geld's sealed records, out and in. Its own error: it never holds up the rest. */
  private async moneyRound(): Promise<void> {
    if (!this.geldKey) return
    try {
      const result = await this.moneyVault.round(this.geldKey, this.vaultTransport)
      if (result.applied > 0) this.announce(result.tables)
      this.moneySyncAt = Date.now()
      this.moneyError = null
    } catch (error) {
      this.moneyError = error instanceof Error ? error.message : String(error)
    }
  }

  vaultStatus(): MoneyVaultStatus {
    return {
      enabled: Boolean(this.geldKey),
      paired: this.paired,
      lastSyncAt: this.moneySyncAt,
      lastError: this.moneyError,
      pending: this.moneyVault.pending()
    }
  }

  async vaultSetup(passphrase: string): Promise<MoneyVaultStatus> {
    if (!this.paired) throw new Error('Koppel de telefoon eerst aan de server (Instellingen → Sync).')
    this.geldKey = await this.moneyVault.setup(passphrase, this.vaultTransport)
    await Preferences.set({ key: KEY_GELD, value: this.geldKey })
    await this.moneyRound()
    return this.vaultStatus()
  }

  async vaultForget(): Promise<MoneyVaultStatus> {
    this.geldKey = ''
    await Preferences.remove({ key: KEY_GELD })
    this.moneyVault.forget()
    this.moneySyncAt = null
    this.moneyError = null
    return this.vaultStatus()
  }

  /** Links the phone. Always a download: the laptop put the data on the server first. */
  async pair(serverUrl: string, token: string, mode: 'upload' | 'download'): Promise<SyncStatus> {
    if (mode === 'upload') {
      throw new Error('A phone joins with “Download the server’s copy”; the laptop sends the first copy.')
    }
    const url = serverUrl.trim().replace(/\/+$/, '')
    if (!/^https:\/\//i.test(url)) throw new Error('The server address must start with https://.')

    const server = await this.json<{ initialized: boolean; schema: number; device: string }>(
      'GET',
      '/api/sync/status',
      undefined,
      { url, token }
    )
    if (!server.initialized) throw new Error('The server is still empty. Link the laptop first, with “Upload”.')
    if (server.schema !== schemaVersion(this.db)) {
      throw new Error(`The server is on database version ${server.schema}, this app on ${schemaVersion(this.db)}.`)
    }

    const response = await this.fetch('GET', `${url}/api/sync/snapshot`, token)
    const seq = Number(response.headers.get('X-Uurwerk-Seq') ?? '0')
    await stageIncoming(new Uint8Array(await response.arrayBuffer()))

    await Preferences.set({ key: KEY_URL, value: url })
    await Preferences.set({ key: KEY_TOKEN, value: token })
    await Preferences.set({ key: KEY_ADOPT, value: JSON.stringify({ device: server.device, seq }) })

    // The new file is opened by a fresh start of the app's web view.
    window.location.reload()
    return this.status()
  }

  async unpair(): Promise<SyncStatus> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.quiet()
    this.url = ''
    this.token = ''
    await Preferences.remove({ key: KEY_URL })
    await Preferences.remove({ key: KEY_TOKEN })
    return this.status()
  }

  async forward(domain: string, method: string, args: unknown[]): Promise<unknown> {
    await this.round()
    if (!this.online) {
      throw new Error('This needs the server, and the server cannot be reached right now.')
    }
    const result = await this.json('POST', `/api/rpc/${domain}/${method}`, args)
    await this.round()
    return result
  }

  // ----------------------------------------------------------------- HTTP

  private async json<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    override?: { url: string; token: string }
  ): Promise<T> {
    const response = await this.fetch(
      method,
      `${override?.url ?? this.url}${path}`,
      override?.token ?? this.token,
      body
    )
    const text = await response.text()
    return (text ? JSON.parse(text) : null) as T
  }

  private async fetch(method: 'GET' | 'POST', url: string, token: string, body?: unknown): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal
      })
      if (!response.ok) {
        throw new Error(
          response.status === 401
            ? 'The server does not accept this device token.'
            : `${method} ${new URL(url).pathname} failed: ${response.status} ${(await response.text()).slice(0, 200)}`
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
