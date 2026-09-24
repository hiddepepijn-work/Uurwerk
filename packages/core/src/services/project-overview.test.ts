/**
 * Reading one project in the order the work has to happen.
 *
 * The interesting cases are all about the difference between "what matters most" and "what
 * can I actually start" — the task list answers the first, and answering the second is the
 * only reason this service exists.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { openStore, type Store } from '../db/index.js'
import { SYSTEM_AREAS, SYSTEM_ORGANIZATIONS } from '../contract/types.js'
import { ProjectOverviewService } from './project-overview.js'

const TODAY = '2026-08-22'

let store: Store
let service: ProjectOverviewService
let project: string

beforeEach(() => {
  store = openStore(':memory:')
  service = new ProjectOverviewService(store)
  project = store.projects.create({
    name: 'SDSS De Margriet',
    organizationId: SYSTEM_ORGANIZATIONS.maasarend,
    areaId: SYSTEM_AREAS.stage
  }).id
})

const task = (
  title: string,
  extra: { estimateMin?: number; dueDate?: string; priority?: 'high' | 'medium' | 'low' } = {}
): string =>
  store.tasks.create({
    title,
    projectId: project,
    areaId: SYSTEM_AREAS.stage,
    ...extra
  }).id

/** A chain of chapters, the shape the whole feature is built around. */
const chain = (): { six: string; seven: string; eight: string } => {
  const six = task('Hoofdstuk 6 afmaken', { estimateMin: 180, priority: 'low' })
  const seven = task('Afmaken hoofdstuk 7', { estimateMin: 240, priority: 'high' })
  const eight = task('Hoofdstuk 8', { estimateMin: 120, priority: 'high' })
  store.dependencies.add(seven, six, 'hard')
  store.dependencies.add(eight, seven, 'hard')
  return { six, seven, eight }
}

describe('the order', () => {
  it('puts a prerequisite before the work that needs it, whatever the priority says', () => {
    const { six, seven, eight } = chain()

    const rows = service.overview(project, TODAY).tasks

    // Chapter six is the lowest priority and has to come first anyway.
    expect(rows.map((row) => row.taskId)).toEqual([six, seven, eight])
    expect(rows.map((row) => row.order)).toEqual([1, 2, 3])
  })

  it('ranks by priority between two tasks that are equally free to start', () => {
    const low = task('Tidy up', { priority: 'low' })
    const high = task('Urgent thing', { priority: 'high' })

    const rows = service.overview(project, TODAY).tasks

    expect(rows.map((row) => row.taskId)).toEqual([high, low])
  })

  it('only lists the tasks of the project asked for', () => {
    task('Mine')
    const other = store.projects.create({ name: 'Something else', areaId: SYSTEM_AREAS.work }).id
    store.tasks.create({ title: 'Theirs', projectId: other, areaId: SYSTEM_AREAS.work })

    const rows = service.overview(project, TODAY).tasks

    expect(rows).toHaveLength(1)
    expect(rows[0]!.title).toBe('Mine')
  })
})

describe('what can be picked up', () => {
  it('marks the head of a chain ready and everything behind it waiting', () => {
    chain()

    const overview = service.overview(project, TODAY)

    expect(overview.tasks.map((row) => row.readiness)).toEqual(['ready', 'waiting', 'waiting'])
    expect(overview.nextTaskId).toBe(overview.tasks[0]!.taskId)
  })

  it('names what a waiting task is waiting for', () => {
    const { six, seven } = chain()

    const row = service.overview(project, TODAY).tasks.find((entry) => entry.taskId === seven)!

    expect(row.waitingOn).toEqual([{ taskId: six, title: 'Hoofdstuk 6 afmaken', order: 1 }])
  })

  it('moves the next task along as the chain is finished', () => {
    const { six, seven } = chain()
    store.tasks.complete(six, true)

    const overview = service.overview(project, TODAY)

    expect(overview.nextTaskId).toBe(seven)
    expect(overview.tasks.find((row) => row.taskId === six)!.readiness).toBe('done')
    expect(overview.tasks.find((row) => row.taskId === seven)!.readiness).toBe('ready')
  })

  it('lets a hand-marked block outrank the graph', () => {
    const solo = task('Waiting on the supervisor')
    store.tasks.update(solo, { status: 'blocked', blockedReason: 'no reply' })

    const row = service.overview(project, TODAY).tasks[0]!

    expect(row.readiness).toBe('blocked')
    expect(row.blockedReason).toBe('no reply')
  })

  it('reports nothing to pick up when every open task is waiting or blocked', () => {
    const stuck = task('Stuck')
    store.tasks.update(stuck, { status: 'blocked', blockedReason: 'no reply' })

    expect(service.overview(project, TODAY).nextTaskId).toBeNull()
  })
})

describe('what a task holds up', () => {
  it('lists the unfinished work waiting on it', () => {
    const { six, seven, eight } = chain()

    const row = service.overview(project, TODAY).tasks.find((entry) => entry.taskId === six)!

    // Only the direct dependant: eight waits on seven, not on six.
    expect(row.blocks.map((entry) => entry.taskId)).toEqual([seven])
    expect(row.blocks[0]!.order).toBe(2)
    expect(eight).toBeDefined()
  })

  it('stops counting a dependant once it is finished', () => {
    const { six, seven } = chain()
    store.tasks.complete(seven, true)

    const row = service.overview(project, TODAY).tasks.find((entry) => entry.taskId === six)!

    expect(row.blocks).toHaveLength(0)
  })
})

describe('when the work is scheduled', () => {
  it('reads the dates from the accepted plan, never from a draft', () => {
    const id = task('Hoofdstuk 6 afmaken', { estimateMin: 180 })
    const draft = store.plans.createDraft({ scope: 'day', periodKey: '2026-08-24' })
    store.plans.addBlock(draft.id, {
      taskId: id,
      date: '2026-08-24',
      startMin: 9 * 60,
      endMin: 11 * 60,
      kind: 'task'
    })

    expect(service.overview(project, TODAY).tasks[0]!.plannedFrom).toBeNull()

    store.plans.accept(draft.id)

    const row = service.overview(project, TODAY).tasks[0]!
    expect(row.plannedFrom).toBe('2026-08-24')
    expect(row.plannedMin).toBe(120)
  })

  it('spans the first and last day a task is planned across', () => {
    const id = task('Long one', { estimateMin: 600 })
    for (const date of ['2026-08-24', '2026-08-26']) {
      const draft = store.plans.createDraft({ scope: 'day', periodKey: date })
      store.plans.addBlock(draft.id, {
        taskId: id,
        date,
        startMin: 9 * 60,
        endMin: 11 * 60,
        kind: 'task'
      })
      store.plans.accept(draft.id)
    }

    const row = service.overview(project, TODAY).tasks[0]!
    expect(row.plannedFrom).toBe('2026-08-24')
    expect(row.plannedTo).toBe('2026-08-26')
    expect(row.plannedMin).toBe(240)
  })

  it('counts work with an estimate and no plan as unscheduled', () => {
    task('Estimated but homeless', { estimateMin: 120 })
    // No estimate means no claim about how long it takes, so it cannot be counted as
    // hours nobody found — that would report every stray idea as a scheduling failure.
    task('No estimate at all')

    expect(service.overview(project, TODAY).unplannedCount).toBe(1)
  })
})

describe('the totals', () => {
  it('counts time left per task, so an overrun cannot cancel out other work', () => {
    const over = task('Overran', { estimateMin: 60 })
    task('Untouched', { estimateMin: 120 })

    const run = store.tracking.startRun(Date.parse('2026-08-20T09:00:00'))
    const segment = store.tracking.startSegment({
      trackingRunId: run.id,
      taskId: over,
      areaId: SYSTEM_AREAS.stage,
      countsAsStageHours: true,
      at: Date.parse('2026-08-20T09:00:00')
    })
    store.tracking.endSegment(segment.id, Date.parse('2026-08-20T12:00:00'))

    const overview = service.overview(project, TODAY)

    // 3h logged against a 1h estimate leaves 0 on that task, not −2h against the other.
    expect(overview.loggedMin).toBe(180)
    expect(overview.remainingMin).toBe(120)
  })

  it('takes the last deadline as the end of the project', () => {
    task('Early', { dueDate: '2026-08-24' })
    task('Late', { dueDate: '2026-08-28' })

    expect(service.overview(project, TODAY).finalDueDate).toBe('2026-08-28')
  })

  it('ignores finished work when reporting the deadline and the overdue count', () => {
    const late = task('Late', { dueDate: '2026-09-30' })
    task('Overdue', { dueDate: '2026-08-01' })
    store.tasks.complete(late, true)

    const overview = service.overview(project, TODAY)

    expect(overview.finalDueDate).toBe('2026-08-01')
    expect(overview.overdueCount).toBe(1)
  })

  it('carries the area, so the screen can say who the work is for', () => {
    task('Anything')
    expect(service.overview(project, TODAY).areaName).toBe('Stage')
  })

  it('refuses a project that does not exist', () => {
    expect(() => service.overview('nope', TODAY)).toThrow(/project not found/i)
  })
})
