/**
 * ★ The server's copy of Uurwerk. ★
 *
 * The same backend the laptop runs (packages/backend), on the main copy of the database,
 * behind four doors that a device opens with its token:
 *
 *   POST /api/sync             push rows, pull rows — one round trip
 *   GET  /api/sync/status      is there data yet, which schema, who am I
 *   GET  /api/sync/snapshot    the whole database, for a device joining
 *   PUT  /api/sync/snapshot    the first device's database, once, into an empty server
 *   PUT  /api/files/{id}.{ext} the bytes of a screenshot or timelapse
 *   POST /api/rpc/{domain}/{method}  any TimeTrackerAPI call, run here
 *   GET  /api/events           server-sent events, for a browser or phone watching live
 *
 * server.js checks the token and hands over the device's name; nothing in here trusts a
 * request that did not come through that check.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'

import { CHANNELS } from '@core/contract/channels.js'
import type { AppEventName, AppEvents } from '@core/contract/events.js'
import {
  compact,
  feed,
  receive,
  schemaVersion,
  type RowChange
} from '@core/sync/engine.js'
import { createBackend, type Backend } from '@backend/create.js'
import { buildImplementation } from '@backend/implementation.js'
import { installHost, unavailable, type SecretKey } from '@backend/host.js'
import { log, setLogFile } from '@backend/log.js'
import { syncAllAccounts } from '@backend/calendar/index.js'
import type { TimeTrackerAPI } from '@core/contract/api.js'
import type { Host } from '@backend/host.js'
import { createJarvis } from './jarvis/index.js'

/** What server.js hands over: the published-files store it already has. */
export interface PublishedStore {
  put(name: string, bytes: Uint8Array): Promise<void>
  remove(name: string): Promise<void>
  /** Tells the reader pages their cached index is stale. */
  invalidate(): void
}

export interface AppOptions {
  dataDir: string
  published: PublishedStore
}

export interface App {
  handle(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
    method: string,
    device: string
  ): Promise<void>
  close(): void
}

const MAX_SYNC = 64 * 1024 * 1024
const MAX_FILE = 64 * 1024 * 1024
const MAX_RPC = 4 * 1024 * 1024
const FILE_NAME = /^[0-9a-f-]{36}\.(jpg|jpeg|png|webm)$/

/** What no remote caller may run here: there is no screen, no window, no second server. */
const NOT_OVER_RPC = new Set([
  'window',
  'startup',
  'sync',
  'capture.markNow',
  'capture.buildTimelapse',
  'reports.openFile'
])

export async function startApp(options: AppOptions): Promise<App> {
  const dbPath = join(options.dataDir, 'uurwerk.db')
  const filesDir = join(options.dataDir, 'files')
  const reportsDir = join(options.dataDir, 'reports')
  const secretsFile = join(options.dataDir, 'secrets.json')
  for (const dir of [filesDir, reportsDir]) mkdirSync(dir, { recursive: true })
  setLogFile(() => join(options.dataDir, 'uurwerk.log'))

  const listeners = new Set<(event: AppEventName, payload: unknown) => void>()

  // ---------------------------------------------------------------- secrets
  // Plain JSON, mode 0600, in a directory only the service user can read. There is no OS
  // keychain on a headless server; file permissions are the lock, as for users.json.
  const readSecrets = (): Record<string, string> => {
    try {
      return JSON.parse(readFileSync(secretsFile, 'utf8')) as Record<string, string>
    } catch {
      return {}
    }
  }
  const secrets = {
    get: (key: SecretKey) => readSecrets()[key] ?? null,
    has: (key: SecretKey) => Boolean(readSecrets()[key]),
    set: (key: SecretKey, value: string) => {
      const vault = readSecrets()
      if (value) vault[key] = value
      else delete vault[key]
      writeFileSync(secretsFile, JSON.stringify(vault), { mode: 0o600 })
    }
  }

  const serverHost: Host = {
    emit<K extends AppEventName>(event: K, payload: AppEvents[K]) {
      for (const listener of listeners) listener(event, payload)
    },
    secrets,
    reportDir: () => reportsDir,
    openPath: unavailable('Opening a file'),
    openExternal: unavailable('Opening a mail draft'),
    showItemInFolder: () => undefined,
    capture: {
      markNow: unavailable('Taking a screenshot'),
      buildTimelapse: unavailable('Encoding a timelapse')
    },
    startup: {
      getLoginItemStatus: unavailable('Start with Windows'),
      setAutoLaunch: unavailable('Start with Windows')
    },
    window: {
      minimizeToTray: unavailable('A window'),
      closeQuickAdd: unavailable('A window'),
      quit: unavailable('Quitting from a device')
    },
    relaunch: unavailable('Restarting from a device'),
    sync: {
      status: unavailable('Sync from the server side'),
      pair: unavailable('Sync from the server side'),
      now: unavailable('Sync from the server side'),
      unpair: unavailable('Sync from the server side')
    },
    fileFor: (artifact) => join(filesDir, `${artifact.id}${extname(artifact.path).toLowerCase()}`),
    publishSink: {
      put: async (name, bytes) => {
        await options.published.put(name, bytes)
        options.published.invalidate()
      },
      remove: async (name) => {
        await options.published.remove(name)
        options.published.invalidate()
      }
    }
  }
  installHost(serverHost)

  // ---------------------------------------------------------------- backend
  // No database until the first device uploads one: an empty server that invented its own
  // areas and settings would be a second, competing copy of the truth.
  let backend: Backend | null = null
  let implementation: Callable | null = null
  const timers: NodeJS.Timeout[] = []

  const open = (): void => {
    backend = createBackend(dbPath)
    const built = buildImplementation(backend)
    implementation = callable(built)
    // Jarvis works through the same implementation the devices call, so what he does syncs.
    serverHost.jarvis = createJarvis(built as unknown as TimeTrackerAPI, secrets)
    backend.trackingService.onChange((segment, reason) => {
      for (const listener of listeners) {
        listener('tracking:segmentChanged', { segment, reason })
        listener('data:invalidated', { domain: 'sessions' })
      }
    })
  }
  if (existsSync(dbPath)) open()

  // -------------------------------------------------------------- scheduler
  let lastCalendarSync = 0
  timers.push(
    setInterval(() => {
      if (!backend) return
      const settings = backend.store.settings.get()
      if (!settings.calendarAutoSync) return
      if (Date.now() - lastCalendarSync < Math.max(5, settings.calendarSyncEveryMin) * 60_000) return
      lastCalendarSync = Date.now()
      void syncAllAccounts(backend).catch((error: unknown) => log.warn('Calendar sync failed.', error))
    }, 60_000)
  )
  timers.push(
    setInterval(() => {
      if (!backend) return
      const removed = compact(backend.store.db)
      const orphans = sweepOrphanFiles(backend, filesDir)
      if (removed > 0 || orphans > 0) log.info('Nightly tidy.', { removed, orphans })
    }, 6 * 3600_000)
  )

  // ----------------------------------------------------------------- routes

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
    method: string,
    device: string
  ): Promise<void> {
    if (path === '/api/sync/status' && method === 'GET') {
      return json(response, 200, {
        initialized: backend !== null,
        schema: backend ? schemaVersion(backend.store.db) : currentSchema(),
        device
      })
    }

    if (path === '/api/sync/snapshot' && method === 'PUT') {
      if (backend) return json(response, 409, { error: 'The server already holds data.' })
      const bytes = await readBody(request, MAX_SYNC)
      writeFileSync(dbPath, bytes)
      open()
      // The uploaded file carries the laptop's own log and position; the server starts fresh.
      backend!.store.db.exec(
        'DELETE FROM _changes; UPDATE _sync_state SET device_id = NULL, last_pulled = 0 WHERE id = 1'
      )
      log.info('The server received its first copy of the data.', { from: device, bytes: bytes.length })
      return json(response, 200, { seq: 0 })
    }

    if (!backend || !implementation) {
      return json(response, 409, { error: 'The server holds no data yet. Pair a device with "upload" first.' })
    }
    const db = backend.store.db

    if (path === '/api/sync' && method === 'POST') {
      const body = JSON.parse((await readBody(request, MAX_SYNC)).toString('utf8')) as {
        schema: number
        since: number
        changes: RowChange[]
      }
      if (body.schema !== schemaVersion(db)) {
        return json(response, 409, {
          error: `Database version differs: device ${body.schema}, server ${schemaVersion(db)}. Update the older one.`
        })
      }
      const received = receive(db, device, body.changes ?? [])
      if (received.applied > 0) {
        for (const listener of listeners) listener('data:invalidated', { domain: 'tasks' })
      }
      return json(response, 200, { received, feed: feed(db, body.since ?? 0, device) })
    }

    if (path === '/api/sync/snapshot' && method === 'GET') {
      const file = join(tmpdir(), `uurwerk-snapshot-${Date.now()}.db`)
      try {
        const seq = db.get<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM _changes')?.seq ?? 0
        db.exec(`VACUUM INTO '${file.replace(/\\/g, '/').replace(/'/g, "''")}'`)
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'X-Uurwerk-Seq': String(seq),
          'Cache-Control': 'no-store'
        })
        response.end(readFileSync(file))
      } finally {
        rmSync(file, { force: true })
      }
      return
    }

    if (path.startsWith('/api/files/') && method === 'PUT') {
      const name = path.slice('/api/files/'.length)
      if (!FILE_NAME.test(name)) return json(response, 400, { error: 'Bad file name.' })
      writeFileSync(join(filesDir, name), await readBody(request, MAX_FILE))
      return json(response, 200, { stored: name })
    }

    if (path.startsWith('/api/rpc/') && method === 'POST') {
      const [domain = '', name = ''] = path.slice('/api/rpc/'.length).split('/')
      const methods = (CHANNELS as Record<string, readonly string[]>)[domain]
      if (!methods?.includes(name) || NOT_OVER_RPC.has(domain) || NOT_OVER_RPC.has(`${domain}.${name}`)) {
        return json(response, 404, { error: `No such call here: ${domain}.${name}` })
      }
      const args = JSON.parse((await readBody(request, MAX_RPC)).toString('utf8') || '[]') as unknown[]
      try {
        const result = await implementation[domain]![name]!(...(Array.isArray(args) ? args : []))
        return json(response, 200, result ?? null)
      } catch (error) {
        log.warn(`RPC ${domain}.${name} failed.`, error)
        return json(response, 422, { error: error instanceof Error ? error.message : String(error) })
      }
    }

    if (path === '/api/events' && method === 'GET') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive'
      })
      response.write(': verbonden\n\n')
      const listener = (event: AppEventName, payload: unknown): void => {
        response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
      }
      const keepAlive = setInterval(() => response.write(': \n\n'), 25_000)
      listeners.add(listener)
      request.on('close', () => {
        clearInterval(keepAlive)
        listeners.delete(listener)
      })
      return
    }

    return json(response, 404, { error: 'Not found.' })
  }

  return {
    handle,
    close() {
      for (const timer of timers) clearInterval(timer)
      backend?.store.db.close()
    }
  }
}

// ------------------------------------------------------------------ helpers

type Callable = Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>

const callable = (implementation: ReturnType<typeof buildImplementation>): Callable =>
  implementation as unknown as Callable

/** The schema a fresh database would have, for a server that has none yet. */
function currentSchema(): number {
  const probe = createBackend(':memory:')
  try {
    return schemaVersion(probe.store.db)
  } finally {
    probe.store.db.close()
  }
}

/** Files whose artifact row is gone: deleted on a device, the delete synced, the bytes left. */
function sweepOrphanFiles(backend: Backend, filesDir: string): number {
  const known = new Set(
    backend.store.db.all<{ id: string }>('SELECT id FROM artifacts').map((row) => row.id)
  )
  let removed = 0
  for (const name of readdirSync(filesDir)) {
    const id = name.replace(/\.[a-z0-9]+$/i, '')
    if (!known.has(id)) {
      rmSync(join(filesDir, name), { force: true })
      removed += 1
    }
  }
  return removed
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  response.end(JSON.stringify(value))
}

function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('too-large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}
