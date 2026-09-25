/**
 * End-to-end check of sync: a real server process on localhost, a real SyncClient.
 *
 *   npm run build:server && npx tsx scripts/sync-e2e.ts
 *
 * Starts the server on a throwaway data directory, makes a device token, pairs a fresh
 * "laptop" copy with `upload`, and then walks through what matters: a task each way, an
 * offline edit that survives, a forwarded server-only call, a screenshot file, and a second
 * device joining with `download`. Exits non-zero on the first thing that does not hold.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createBackend } from '@backend/create.js'
import { installHost, unavailable, type Host, type SecretKey } from '@backend/host.js'
import { finishAdoption, swapInDownloadedCopy, SyncClient } from '@backend/sync-client.js'

const PORT = 8799
const URL = `http://127.0.0.1:${PORT}`

function check(condition: unknown, what: string): void {
  if (!condition) {
    console.error(`✗ ${what}`)
    process.exitCode = 1
    throw new Error(what)
  }
  console.log(`✓ ${what}`)
}

function fakeHost(sync: () => SyncClient): Host {
  const vault = new Map<SecretKey, string>()
  return {
    emit: () => undefined,
    secrets: {
      get: (key) => vault.get(key) ?? null,
      set: (key, value) => void (value ? vault.set(key, value) : vault.delete(key)),
      has: (key) => vault.has(key)
    },
    reportDir: () => tmpdir(),
    openPath: unavailable('open'),
    openExternal: unavailable('open'),
    showItemInFolder: () => undefined,
    capture: { markNow: unavailable('capture'), buildTimelapse: unavailable('timelapse') },
    startup: { getLoginItemStatus: unavailable('startup'), setAutoLaunch: unavailable('startup') },
    window: { minimizeToTray: unavailable('w'), closeQuickAdd: unavailable('w'), quit: unavailable('w') },
    relaunch: async () => undefined,
    sync: {
      status: async () => sync().status(),
      pair: (url, token, mode) => sync().pair(url, token, mode),
      now: async () => {
        await sync().round()
        return sync().status()
      },
      unpair: async () => sync().unpair()
    },
    fileFor: (artifact) => artifact.path
  }
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'uurwerk-e2e-'))
  const dataDir = join(root, 'server')
  const env = {
    ...process.env,
    UURWERK_DATA_DIR: dataDir,
    UURWERK_PORT: String(PORT),
    UURWERK_INSECURE_COOKIES: '1'
  }

  const add = spawn(process.execPath, ['packages/server/bin/uurwerk-devices.js', 'add', 'laptop'], { env })
  let out = ''
  add.stdout.on('data', (chunk) => (out += chunk))
  await new Promise((resolve) => add.on('close', resolve))
  const token = /uw_[0-9a-f]{64}/.exec(out)?.[0] ?? ''
  check(token, 'device token made on the server')

  const server = spawn(process.execPath, ['packages/server/src/server.js'], { env, stdio: 'pipe' })
  server.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`))
  await new Promise((resolve) => server.stdout.once('data', resolve))

  try {
    // ------------------------------------------------------------- laptop
    const laptopDb = join(root, 'laptop.db')
    const laptop = createBackend(laptopDb)
    let laptopSync: SyncClient | null = null
    installHost(fakeHost(() => laptopSync!))
    laptopSync = new SyncClient(laptop, laptopDb)

    const before = laptop.store.tasks.create({ title: 'Al op de laptop' })
    const frame = join(root, 'frame.jpg')
    writeFileSync(frame, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    const artifact = laptop.store.artifacts.add({ day: '2026-09-25', kind: 'screenshot', path: frame })

    await laptopSync.pair(URL, token, 'upload')
    await laptopSync.round()
    laptopSync.stop()

    const rpc = async (domain: string, method: string, args: unknown[] = []): Promise<unknown> => {
      const response = await fetch(`${URL}/api/rpc/${domain}/${method}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args)
      })
      return response.json()
    }

    const serverTasks = (await rpc('tasks', 'list')) as Array<{ id: string; title: string }>
    check(serverTasks.some((task) => task.id === before.id), 'the upload carried the laptop’s existing tasks')
    check(existsSync(join(dataDir, 'files', `${artifact.id}.jpg`)), 'the screenshot file reached the server')

    const onLaptop = laptop.store.tasks.create({ title: 'Na het koppelen' })
    await laptopSync.round()
    const afterRound = (await rpc('tasks', 'list')) as Array<{ id: string }>
    check(afterRound.some((task) => task.id === onLaptop.id), 'a new laptop task reaches the server')

    const onServer = (await rpc('tasks', 'create', [{ title: 'Via de server' }])) as { id: string }
    await laptopSync.round()
    check(laptop.store.tasks.get(onServer.id)?.title === 'Via de server', 'a server task reaches the laptop')

    // Offline: nothing reaches the server, nothing is lost.
    laptop.store.settings.update({ serverUrl: 'http://127.0.0.1:1' })
    laptop.store.tasks.update(before.id, { title: 'Offline aangepast' })
    await laptopSync.round()
    check(!laptopSync.status().online && laptopSync.status().pending > 0, 'offline, the edit waits in the queue')
    laptop.store.settings.update({ serverUrl: URL })
    await laptopSync.round()
    const [afterOffline] = ((await rpc('tasks', 'list')) as Array<{ id: string; title: string }>).filter(
      (task) => task.id === before.id
    )
    check(afterOffline?.title === 'Offline aangepast', 'back online, the offline edit arrives')

    const forwarded = await laptopSync.forward('calendar', 'syncNow', [])
    check(Array.isArray(forwarded), 'a server-only call is forwarded and answered')

    // ------------------------------------------------------- second device
    const phoneDb = join(root, 'phone.db')
    const phone = createBackend(phoneDb)
    let phoneSync: SyncClient | null = null
    installHost(fakeHost(() => phoneSync!))
    phoneSync = new SyncClient(phone, phoneDb)
    await phoneSync.pair(URL, token, 'download')
    phone.store.db.close()

    swapInDownloadedCopy(phoneDb)
    const reopened = createBackend(phoneDb)
    phoneSync = new SyncClient(reopened, phoneDb)
    finishAdoption(reopened)
    check(reopened.store.tasks.get(onServer.id)?.title === 'Via de server', 'a second device joins with everything')
    check(reopened.store.tasks.get(before.id)?.title === 'Offline aangepast', 'including the later edits')

    laptop.store.db.close()
    reopened.store.db.close()
    console.log('\nSync holds end to end.')
  } finally {
    server.kill()
    rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
