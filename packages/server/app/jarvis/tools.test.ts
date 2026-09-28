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

  it('makes a new task and places it in one proposal', async () => {
    const day = next(2)
    const done = await proposeAndConfirm('create_task', { title: 'Boodschappen doen', areaId: 'personal', estimateMinutes: 30, date: day, start: '17:00', end: '17:30' })
    expect(done.failed).toEqual([])
    expect(done.executed[0]!.summary).toContain('ingepland op')
    expect(done.executed[0]!.result).toMatchObject({ created: 'Boodschappen doen', placed: `${day} 17:00–17:30` })
    const blocks = (await api.plans.day(day)).blocks.filter((block) => block.taskTitle === 'Boodschappen doen')
    expect(blocks.map((block) => [block.startMin, block.endMin])).toEqual([[17 * 60, 17 * 60 + 30]])

    const half = (await runTool(api, 'create_task', { title: 'Half', areaId: 'personal', date: day, start: '18:00' })) as { error?: string }
    expect(half.error).toContain('date, start én end')
  })

  it('lets tasks run through each other, and says so', async () => {
    const day = next(4)
    const bo = await api.tasks.create({ title: 'BO afmaken', areaId: 'school', estimateMin: 60 })
    const kast = await api.tasks.create({ title: 'Kast fixen', areaId: 'personal', estimateMin: 60 })
    await proposeAndConfirm('schedule_task', { taskId: bo.id, date: day, start: '19:00', end: '20:00' })
    const second = await proposeAndConfirm('schedule_task', { taskId: kast.id, date: day, start: '19:30', end: '20:30' })
    expect(second.failed).toEqual([])
    expect(second.executed[0]!.result).toMatchObject({ alongside: ['BO afmaken 19:00–20:00'] })
    const blocks = (await api.plans.day(day)).blocks.filter((block) => block.kind === 'task')
    expect(blocks.map((block) => block.taskTitle).sort()).toEqual(['BO afmaken', 'Kast fixen'])
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

    // Clearing takes the planner's blocks and what Jarvis placed (the Kast was his), so the
    // stretch is empty of planning afterwards.
    const cleared = await proposeAndConfirm('clear_planning', { from, to })
    expect(cleared.failed).toEqual([])
    expect((await api.plans.day(from)).blocks.filter((block) => block.kind === 'task')).toEqual([])
  })

  it('marks what Jarvis made, and clears only that and the planner, never what Hidde set', async () => {
    const day = next(3)
    const task = await api.tasks.create({ title: 'BO afmaken', areaId: 'school', estimateMin: 60 })
    const own = await api.tasks.create({ title: 'Zelf gezet', areaId: 'personal', estimateMin: 60 })
    await proposeAndConfirm('schedule_task', { taskId: task.id, date: day, start: '20:00', end: '21:00' })
    // Hidde's own block, placed in the app.
    const draft = await api.plans.draft(day)
    await api.plans.addBlock(draft.plan!.id, { taskId: own.id, date: day, startMin: 1320, endMin: 1380, source: 'manual', locked: true })
    await api.plans.accept(draft.plan!.id)

    const appointment = await proposeAndConfirm('create_appointment', {
      title: 'Kapper',
      date: day,
      start: '10:00',
      end: '10:30',
      areaId: 'personal'
    })
    const [event] = await api.calendar.eventsInRange(new Date(`${day}T00:00:00`).getTime(), new Date(`${day}T23:59:00`).getTime())
    expect(event).toMatchObject({ title: 'Kapper', createdBy: 'jarvis' })
    expect(appointment.executed).toHaveLength(1)

    expect((await api.plans.day(day)).blocks.find((block) => block.taskId === task.id)?.createdBy).toBe('jarvis')

    const cleared = await proposeAndConfirm('clear_planning', { from: day, to: day })
    expect(cleared.executed[0]!.result).toMatchObject({ removedBlocks: 1 })
    const left = (await api.plans.day(day)).blocks
    expect(left.map((block) => block.taskId)).toEqual([own.id])
    // Appointments are not planning: the Kapper stays.
    expect(await api.calendar.eventsInRange(new Date(`${day}T00:00:00`).getTime(), new Date(`${day}T23:59:00`).getTime())).toHaveLength(1)
  })

  it('gives a compact snapshot, with short refs the tools accept as ids', async () => {
    const day = next(4)
    const task = await api.tasks.create({ title: 'BO afmaken', areaId: 'school', estimateMin: 60, dueDate: '2020-01-01' })
    const text = (await runTool(api, 'get_snapshot', { from: day, to: day })) as string
    const shortRef = `t:${task.id.replace(/-/g, '').slice(0, 6)}`
    expect(text).toContain(`${shortRef} BO afmaken [school] medium, 60 min, deadline 2020-01-01 TE LAAT`)

    // The ref works as the id in a proposal.
    const placed = await proposeAndConfirm('schedule_task', { taskId: shortRef, date: day, start: '20:00', end: '21:00' })
    expect(placed.executed).toHaveLength(1)
    expect((await runTool(api, 'get_snapshot', { from: day, to: day, tasks: false })) as string).toContain(
      `20:00-21:00 BO afmaken [school] (jarvis) ${shortRef}`
    )
  })

  it('places tasks one after another after the appointments, never over them (regressie 3)', async () => {
    const day = next(2)
    // Hidde works on into the evening on a Tuesday.
    await api.availability.save({
      week: null,
      weekday: 2,
      startMin: 9 * 60,
      endMin: 23 * 60,
      allowedAreas: [],
      areaTargets: {},
      stageStartMin: 9 * 60,
      stageEndMin: 18 * 60,
      enabled: true
    })
    const bo = await api.tasks.create({ title: 'BO afmaken', areaId: 'school', estimateMin: 90 })
    const wbw = await api.tasks.create({ title: 'Wie betaald wat invullen', areaId: 'personal', estimateMin: 30 })
    for (const [start, end] of [['19:00', '19:30'], ['19:30', '20:15']]) {
      await api.calendar.createEvent({
        title: `Afspraak ${start}`,
        startsAt: new Date(`${day}T${start}:00`).getTime(),
        endsAt: new Date(`${day}T${end}:00`).getTime(),
        origin: 'uurwerk',
        classificationStatus: 'unclassified',
        includeInPlanning: true,
        registrationMode: 'none',
        countsAsWorked: false
      })
    }
    const proposed = (await runTool(api, 'propose_plan', {
      taskIds: [bo.id, wbw.id],
      after: `${day}T19:00`,
      minutes: 60
    })) as Proposed
    expect(proposed.summary).toContain('20:15–21:15')
    expect(proposed.summary).toContain('21:15–22:15')
    // Nothing written before the ja.
    expect((await api.plans.day(day)).blocks).toEqual([])

    const done = (await runTool(api, 'confirm', { pendingIds: [proposed.pendingId] })) as Confirmed
    expect(done.executed[0]!.result).toMatchObject({ placedCount: 2 })
    // The laptop's corner shows these as cards springing out of the orb.
    const cards = (done.executed[0] as unknown as { cards: Array<{ kind: string; title: string; when: string }> }).cards
    expect(cards.map((card) => [card.kind, card.title, card.when.slice(-11)])).toEqual([
      ['planning', 'BO afmaken', '20:15–21:15'],
      ['planning', 'Wie betaald wat invullen', '21:15–22:15']
    ])
    const blocks = (await api.plans.day(day)).blocks.filter((block) => block.kind === 'task')
    expect(blocks.map((block) => [block.taskTitle, block.startMin, block.endMin])).toEqual([
      ['BO afmaken', 1215, 1275],
      ['Wie betaald wat invullen', 1275, 1335]
    ])
  })

  it('keeps stage work inside the internship hours when it places it', async () => {
    const monday = next(1)
    const stage = await api.tasks.create({ title: 'Architectuur onderzoek', areaId: 'stage', estimateMin: 60 })
    const proposed = (await runTool(api, 'propose_plan', { taskIds: [stage.id], after: `${monday}T19:00` })) as Proposed
    // After seven in the evening there is no internship left that day: the next weekday, at nine.
    expect(proposed.summary).toMatch(/09:00–10:00/)
    expect(proposed.summary).not.toContain(monday.slice(8).replace(/^0/, '') + '/')
  })

  it('makes "voortaan geen stage op woensdag" a hard rule the planner keeps', async () => {
    const added = await proposeAndConfirm('add_rule', {
      type: 'stage_window',
      description: 'Stage alleen ma, di, do en vr, 9 tot 5',
      days: [1, 2, 4, 5],
      from: '09:00',
      to: '17:00'
    })
    expect(added.failed).toEqual([])
    expect(added.executed[0]!.result).toMatchObject({ kind: 'hard' })

    const wednesday = next(3)
    await api.tasks.create({ title: 'Architectuur onderzoek', areaId: 'stage', estimateMin: 900 })
    await proposeAndConfirm('plan_range', { from: wednesday, to: wednesday })
    expect((await api.plans.day(wednesday)).blocks.filter((block) => block.areaId === 'stage')).toEqual([])

    const thursday = next(4)
    await proposeAndConfirm('plan_range', { from: thursday, to: thursday })
    const stageBlocks = (await api.plans.day(thursday)).blocks.filter((block) => block.areaId === 'stage')
    expect(stageBlocks.length).toBeGreaterThan(0)
    expect(Math.max(...stageBlocks.map((block) => block.endMin))).toBeLessThanOrEqual(17 * 60)

    const rules = (await runTool(api, 'list_rules', {})) as Array<{ kind: string; description: string }>
    expect(rules).toEqual([expect.objectContaining({ kind: 'hard', description: 'Stage alleen ma, di, do en vr, 9 tot 5' })])
    expect((await runTool(api, 'get_snapshot', {})) as string).toContain('hard: Stage alleen ma, di, do en vr, 9 tot 5')
  })

  it('keeps the day summary a next conversation starts from', async () => {
    expect(await runTool(api, 'note_day_summary', { summary: 'BO af. Wie betaalt wat niet; morgen eerst.' })).toEqual({ saved: true })
    const today = ahead(0)
    expect((await api.assistant.dayLog(today)).summary).toBe('BO af. Wie betaalt wat niet; morgen eerst.')
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
