import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openStore, type Store } from '../db/index.js'
import {
  acknowledge,
  adoptSnapshot,
  applyChanges,
  compact,
  feed,
  lastPulled,
  pendingChanges,
  receive,
  setLastPulled
} from './engine.js'

let server: Store
let laptop: Store

beforeEach(() => {
  server = openStore(':memory:')
  laptop = openStore(':memory:')
})

/** One full round, the way the desktop app runs it: push, acknowledge, pull. */
function round(device: Store, id = 'laptop'): { applied: number; stale: number } {
  const { changes, upTo } = pendingChanges(device.db)
  const pushed = receive(server.db, id, changes)
  expect(pushed.failed).toEqual([])
  acknowledge(device.db, upTo)

  const pulled = feed(server.db, lastPulled(device.db), id)
  const applied = applyChanges(device.db, pulled.changes)
  expect(applied.failed).toEqual([])
  setLastPulled(device.db, pulled.seq)
  return { applied: pushed.applied, stale: pushed.stale }
}

describe('a fresh copy', () => {
  it('logs nothing for what the migrations wrote — every copy ran them itself', () => {
    expect(pendingChanges(laptop.db).changes).toEqual([])
    expect(pendingChanges(server.db).changes).toEqual([])
  })
})

describe('both directions', () => {
  it('carries a task made on the laptop to the server', () => {
    const task = laptop.tasks.create({ title: 'Veldronde voorbereiden', priority: 'high' })
    round(laptop)

    expect(server.tasks.get(task.id)?.title).toBe('Veldronde voorbereiden')
    expect(server.tasks.get(task.id)?.priority).toBe('high')
  })

  it('carries an edit made on the server back to the laptop', () => {
    const task = laptop.tasks.create({ title: 'Rapport' })
    round(laptop)

    server.tasks.update(task.id, { title: 'Rapport week 39' })
    round(laptop)

    expect(laptop.tasks.get(task.id)?.title).toBe('Rapport week 39')
  })

  it('merges work done on both sides while the laptop was offline', () => {
    const onLaptop = laptop.tasks.create({ title: 'Offline in de trein' })
    const onServer = server.tasks.create({ title: 'Via Jarvis aangemaakt' })
    round(laptop)

    expect(laptop.tasks.get(onServer.id)?.title).toBe('Via Jarvis aangemaakt')
    expect(server.tasks.get(onLaptop.id)?.title).toBe('Offline in de trein')
  })

  it('does not echo the laptop its own change back', () => {
    laptop.tasks.create({ title: 'Eigen wijziging' })
    const { changes } = pendingChanges(laptop.db)
    receive(server.db, 'laptop', changes)

    expect(feed(server.db, 0, 'laptop').changes).toEqual([])
    expect(feed(server.db, 0, 'phone').changes).toHaveLength(1)
  })

  it('carries deletes', () => {
    const task = laptop.tasks.create({ title: 'Weg ermee' })
    round(laptop)
    laptop.tasks.remove(task.id)
    round(laptop)

    expect(server.tasks.get(task.id)).toBeNull()
  })
})

describe('the same row changed on both sides', () => {
  it('keeps the later edit, wherever it was made', () => {
    const task = laptop.tasks.create({ title: 'Origineel' })
    round(laptop)

    laptop.tasks.update(task.id, { title: 'Laptop, eerder' })
    // The laptop's edit is made to look ten seconds older than the server's.
    laptop.db.run("UPDATE _changes SET at = at - 10000 WHERE tbl = 'tasks'")
    server.tasks.update(task.id, { title: 'Server, later' })

    const outcome = round(laptop)
    expect(outcome.stale).toBe(1)
    expect(server.tasks.get(task.id)?.title).toBe('Server, later')
    expect(laptop.tasks.get(task.id)?.title).toBe('Server, later')
  })

  it('does not let a pull overwrite an edit made while the round was in flight', () => {
    const task = laptop.tasks.create({ title: 'Eerste' })
    round(laptop)
    server.tasks.update(task.id, { title: 'Van de server' })

    const { changes, upTo } = pendingChanges(laptop.db)
    receive(server.db, 'laptop', changes)
    acknowledge(laptop.db, upTo)
    // Typed between push and pull.
    laptop.tasks.update(task.id, { title: 'Net getypt' })
    applyChanges(laptop.db, feed(server.db, 0, 'laptop').changes)

    expect(laptop.tasks.get(task.id)?.title).toBe('Net getypt')
    round(laptop)
    expect(server.tasks.get(task.id)?.title).toBe('Net getypt')
  })
})

describe('what must survive an update', () => {
  it('keeps a task’s dependencies when the task row is updated from elsewhere', () => {
    const first = laptop.tasks.create({ title: 'Data ophalen' })
    const second = laptop.tasks.create({ title: 'Analyse' })
    laptop.dependencies.setForTask(second.id, [{ dependsOnTaskId: first.id, type: 'hard' }])
    round(laptop)
    expect(server.dependencies.forTask(second.id)).toHaveLength(1)

    // INSERT OR REPLACE would delete the task first and cascade the dependency away.
    laptop.tasks.update(first.id, { title: 'Data ophalen (AHN)' })
    round(laptop)
    expect(server.dependencies.forTask(second.id)).toHaveLength(1)
  })
})

describe('settings', () => {
  it('shares personal settings and keeps machine settings on the machine', () => {
    laptop.settings.update({
      dailyGoalMin: 7 * 60,
      hotkeys: { ...laptop.settings.get().hotkeys, startStop: 'F9' }
    })
    round(laptop)

    expect(server.settings.get().dailyGoalMin).toBe(7 * 60)
    expect(server.settings.get().hotkeys.startStop).not.toBe('F9')
  })
})

describe('the server’s log', () => {
  it('compacts to one entry per row without changing what a device receives', () => {
    const task = server.tasks.create({ title: 'a' })
    server.tasks.update(task.id, { title: 'b' })
    server.tasks.update(task.id, { title: 'c' })

    const before = feed(server.db, 0, 'laptop').changes
    expect(compact(server.db)).toBeGreaterThan(0)
    expect(feed(server.db, 0, 'laptop').changes).toEqual(before)
  })
})

describe('joining with a snapshot', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uurwerk-sync-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('starts a new device from the server’s file and picks up from there', () => {
    const early = server.tasks.create({ title: 'Al op de server' })
    const file = join(dir, 'snapshot.db')
    server.db.exec(`VACUUM INTO '${file.replace(/\\/g, '/')}'`)
    const seq = feed(server.db, 0, 'phone').seq

    const phone = openStore(file)
    adoptSnapshot(phone.db, 'phone', seq)
    expect(phone.tasks.get(early.id)?.title).toBe('Al op de server')
    expect(pendingChanges(phone.db).changes).toEqual([])

    const later = server.tasks.create({ title: 'Later erbij' })
    round(phone, 'phone')
    expect(phone.tasks.get(later.id)?.title).toBe('Later erbij')
    phone.db.close()
  })
})
