import { beforeEach, describe, expect, it } from 'vitest'

import type { TimeTrackerAPI } from '@core/contract/api.js'
import { createBackend } from '@backend/create.js'
import { installHost, unavailable, type Host } from '@backend/host.js'
import { buildImplementation } from '@backend/implementation.js'

import { runTool } from '@core/services/jarvis-tools.js'

let api: TimeTrackerAPI

beforeEach(() => {
  installHost({
    emit: () => undefined,
    secrets: { get: () => null, set: () => undefined, has: () => false },
    reportDir: () => '',
    openPath: unavailable('open'),
    openExternal: unavailable('open'),
    showItemInFolder: () => undefined,
    capture: { markNow: unavailable('capture'), buildTimelapse: unavailable('timelapse') },
    startup: { getLoginItemStatus: unavailable('startup'), setAutoLaunch: unavailable('startup') },
    window: { minimizeToTray: unavailable('w'), closeQuickAdd: unavailable('w'), quit: unavailable('w') },
    relaunch: unavailable('relaunch'),
    sync: { status: unavailable('s'), pair: unavailable('s'), now: unavailable('s'), unpair: unavailable('s') },
    fileFor: (artifact) => artifact.path
  } satisfies Host)
  api = buildImplementation(createBackend(':memory:')) as unknown as TimeTrackerAPI
})

describe('Jarvis tools', () => {
  it('refuses to write without Hidde having confirmed', async () => {
    const result = await runTool(api, 'create_task', { title: 'Iets', areaId: 'personal', confirmed: false })
    expect(result).toHaveProperty('refused')
    expect(await api.tasks.list({ status: 'active' })).toHaveLength(0)
  })

  it('creates a task with everything it was told, notes included', async () => {
    await runTool(api, 'create_task', {
      title: 'Rapport hoofdstuk 3',
      areaId: 'school',
      priority: 'high',
      estimateMinutes: 120,
      dueDate: '2026-10-02',
      notes: 'Klaar als: ingeleverd in Brightspace\nBelangrijk: ja',
      confirmed: true
    })
    const [task] = await api.tasks.list({ status: 'active' })
    expect(task).toMatchObject({ title: 'Rapport hoofdstuk 3', areaId: 'school', estimateMin: 120, dueDate: '2026-10-02' })
    expect(task!.notes).toContain('Brightspace')
  })

  it('creates an appointment with its journey, and says when to leave', async () => {
    const result = (await runTool(api, 'create_appointment', {
      title: 'Etentje met Tessie',
      date: '2026-09-28',
      start: '19:00',
      end: '21:00',
      areaId: 'personal',
      location: 'Arnhem',
      travelMinutes: 35,
      travelBack: true,
      notes: 'Bloemen meenemen',
      confirmed: true
    })) as { leaveAt: string; reminders: string }

    expect(result.leaveAt).toBe('18:25')
    expect(result.reminders).toContain('17:55')

    const agenda = (await runTool(api, 'get_agenda', { from: '2026-09-28', to: '2026-09-28' })) as {
      appointments: Array<{ title: string; kind: string; from: string; notes: string | null }>
    }
    const dinner = agenda.appointments.find((entry) => entry.title === 'Etentje met Tessie')
    expect(dinner?.notes).toBe('Bloemen meenemen')
    expect(agenda.appointments.filter((entry) => entry.kind === 'travel').map((entry) => entry.from).sort()).toEqual([
      '18:25',
      '21:00'
    ])
  })

  it('reviews a day: what got done, what did not', async () => {
    const done = await api.tasks.create({ title: 'Af', areaId: 'stage' })
    const open = await api.tasks.create({ title: 'Niet af', areaId: 'stage' })
    const draft = await api.plans.draft('2026-09-28')
    await api.plans.addBlock(draft.plan!.id, { date: '2026-09-28', startMin: 540, endMin: 600, taskId: done.id, kind: 'task' })
    await api.plans.addBlock(draft.plan!.id, { date: '2026-09-28', startMin: 600, endMin: 660, taskId: open.id, kind: 'task' })
    await api.plans.accept(draft.plan!.id)
    await api.tasks.complete(done.id, true)

    const review = (await runTool(api, 'day_review', { date: '2026-09-28' })) as {
      done: string[]
      notDone: Array<{ title: string }>
    }
    expect(review.done).toEqual(['Af'])
    expect(review.notDone.map((task) => task.title)).toEqual(['Niet af'])
  })
})
