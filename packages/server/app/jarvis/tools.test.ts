import { beforeEach, describe, expect, it } from 'vitest'

import type { TimeTrackerAPI } from '@core/contract/api.js'
import { createBackend } from '@backend/create.js'
import { installHost, unavailable, type Host } from '@backend/host.js'
import { buildImplementation } from '@backend/implementation.js'

import { runTool } from '@core/services/jarvis-tools.js'

let api: TimeTrackerAPI

beforeEach(async () => {
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
  // Proposals live in the module; one test's leftovers are not the next one's.
  await runTool(api, 'cancel', {})
})

/** A date some days from now, so the tests do not age into the past. */
const ahead = (days: number): string => {
  const d = new Date(Date.now() + days * 86_400_000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The next date on a weekday (1 = Monday … 7 = Sunday), at least a day ahead. */
const next = (weekday: number): string => {
  for (let days = 1; days <= 8; days++) {
    const d = new Date(Date.now() + days * 86_400_000)
    if ((d.getDay() || 7) === weekday) return ahead(days)
  }
  throw new Error('unreachable')
}

type Proposed = { pendingId: string; summary: string }
type Confirmed = {
  executed: Array<{ summary: string; result: Record<string, unknown> }>
  failed: Array<{ summary: string; error: string }>
  alreadyDone: string[]
}

/** Proposes, then says ja: what a conversation does in two turns. */
async function proposeAndConfirm(name: string, input: Record<string, unknown>): Promise<Confirmed> {
  const proposed = (await runTool(api, name, input)) as Proposed
  expect(proposed.pendingId).toBeTruthy()
  return (await runTool(api, 'confirm', { pendingIds: [proposed.pendingId] })) as Confirmed
}

describe('Jarvis tools', () => {
  it('only proposes: nothing is written before confirm', async () => {
    const result = (await runTool(api, 'create_task', { title: 'Iets', areaId: 'personal' })) as Proposed
    expect(result.summary).toContain('Iets')
    expect(await api.tasks.list({ status: 'active' })).toHaveLength(0)
  })

  it('carries out the stored proposal on confirm, and only once', async () => {
    const proposed = (await runTool(api, 'create_task', {
      title: 'Rapport hoofdstuk 3',
      areaId: 'school',
      priority: 'high',
      estimateMinutes: 120,
      dueDate: '2026-10-02',
      notes: 'Klaar als: ingeleverd in Brightspace\nBelangrijk: ja'
    })) as Proposed
    const first = (await runTool(api, 'confirm', {})) as Confirmed
    expect(first.executed).toHaveLength(1)
    const [task] = await api.tasks.list({ status: 'active' })
    expect(task).toMatchObject({ title: 'Rapport hoofdstuk 3', areaId: 'school', estimateMin: 120, dueDate: '2026-10-02' })
    expect(task!.notes).toContain('Brightspace')

    // The "ja" again, after "Load failed": reported as done, not done twice.
    const again = (await runTool(api, 'confirm', { pendingIds: [proposed.pendingId] })) as Confirmed
    expect(again.executed).toHaveLength(0)
    expect(again.alreadyDone).toHaveLength(1)
    expect(await api.tasks.list({ status: 'active' })).toHaveLength(1)
  })

  it('says so when there is nothing to confirm', async () => {
    expect(await runTool(api, 'confirm', {})).toHaveProperty('error')
  })

  it('reports a failure instead of claiming success', async () => {
    const result = await proposeAndConfirm('create_task', { title: 'X', areaId: 'school', projectName: 'Bestaat niet' })
    expect(result.executed).toHaveLength(0)
    expect(result.failed[0]!.error).toContain('Bestaat niet')
  })

  it('drops proposals on cancel', async () => {
    await runTool(api, 'create_task', { title: 'Nee toch', areaId: 'personal' })
    expect(await runTool(api, 'cancel', {})).toEqual({ cancelled: 1 })
    expect(await runTool(api, 'confirm', {})).toHaveProperty('error')
    expect(await api.tasks.list({ status: 'active' })).toHaveLength(0)
  })

  it('creates an appointment with its journey, says when to leave, and removes it again', async () => {
    const day = ahead(3)
    const result = await proposeAndConfirm('create_appointment', {
      title: 'Etentje met Tessie',
      date: day,
      start: '19:00',
      end: '21:00',
      areaId: 'personal',
      location: 'Arnhem',
      travelMinutes: 35,
      travelBack: true,
      notes: 'Bloemen meenemen'
    })
    expect(result.executed[0]!.result).toMatchObject({ leaveAt: '18:25' })
    expect(String(result.executed[0]!.result.reminders)).toContain('17:55')

    const agenda = (await runTool(api, 'get_agenda', { from: day, to: day })) as {
      appointments: Array<{ eventId: string; title: string; kind: string; from: string; notes: string | null }>
    }
    const dinner = agenda.appointments.find((entry) => entry.title === 'Etentje met Tessie')
    expect(dinner?.notes).toBe('Bloemen meenemen')
    expect(agenda.appointments.filter((entry) => entry.kind === 'travel').map((entry) => entry.from).sort()).toEqual([
      '18:25',
      '21:00'
    ])

    // And away again, journey included.
    await proposeAndConfirm('delete_appointment', { eventId: dinner!.eventId })
    const after = (await runTool(api, 'get_agenda', { from: day, to: day })) as { appointments: unknown[] }
    expect(after.appointments).toHaveLength(0)
  })

  it('schedules a task at a time, and refuses to put it over an appointment', async () => {
    const day = next(2)
    const task = await api.tasks.create({ title: 'BO afmaken', areaId: 'school', estimateMin: 60 })
    await api.calendar.createEvent({
      title: 'Paspoort',
      startsAt: new Date(`${day}T14:00:00`).getTime(),
      endsAt: new Date(`${day}T15:00:00`).getTime(),
      origin: 'uurwerk',
      classificationStatus: 'unclassified',
      includeInPlanning: true,
      registrationMode: 'none',
      countsAsWorked: false
    })

    const clash = (await runTool(api, 'schedule_task', { taskId: task.id, date: day, start: '14:30', end: '15:30' })) as {
      error?: string
    }
    expect(clash.error).toContain('Paspoort')

    const placed = await proposeAndConfirm('schedule_task', { taskId: task.id, date: day, start: '15:00', end: '16:00' })
    expect(placed.executed[0]!.result).toMatchObject({ placed: `${day} 15:00–16:00` })
    const plan = await api.plans.day(day)
    expect(plan.blocks.find((block) => block.taskId === task.id)).toMatchObject({ startMin: 900, endMin: 960, source: 'manual' })
  })

  it('replans a range around what was set by hand, and never puts stage work at the weekend', async () => {
    const saturday = next(6)
    const sunday = next(7)
    const from = saturday < sunday ? saturday : sunday
    const to = ahead(Math.round((new Date(`${from}T12:00:00`).getTime() - Date.now()) / 86_400_000) + 3)
    await api.tasks.create({ title: 'Architectuur onderzoek', areaId: 'stage', estimateMin: 600 })
    const mine = await api.tasks.create({ title: 'Kast fixen', areaId: 'personal', estimateMin: 60 })
    await proposeAndConfirm('schedule_task', { taskId: mine.id, date: from, start: '14:00', end: '15:00' })

    const result = await proposeAndConfirm('plan_range', { from, to })
    expect(result.failed).toEqual([])
    for (const day of [saturday, sunday]) {
      const plan = await api.plans.day(day)
      expect(plan.blocks.filter((block) => block.areaId === 'stage' && block.kind === 'task')).toEqual([])
    }
    // The block set by hand survived the replan, and its hour counts: not planned twice.
    const range: string[] = []
    for (let day = from; day <= to; day = ahead(Math.round((new Date(`${day}T12:00:00`).getTime() - Date.now()) / 86_400_000) + 1)) range.push(day)
    const kast = (await Promise.all(range.map((day) => api.plans.day(day))))
      .flatMap((plan) => plan.blocks)
      .filter((block) => block.taskId === mine.id)
    expect(kast).toHaveLength(1)
    expect(kast[0]).toMatchObject({ date: from, startMin: 840, source: 'manual' })

    // Clearing takes the planner's blocks and leaves the one set by hand.
    const cleared = await proposeAndConfirm('clear_planning', { from, to })
    expect(cleared.failed).toEqual([])
    expect((await api.plans.day(from)).blocks.find((block) => block.taskId === mine.id)).toBeTruthy()
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
