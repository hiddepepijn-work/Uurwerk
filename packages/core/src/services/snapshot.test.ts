import { beforeEach, describe, expect, it } from 'vitest'
import { openStore, type Store } from '../db/index.js'
import { SYSTEM_AREAS } from '../contract/types.js'
import { MINUTE_MS } from '../util/time.js'
import { SnapshotService, MASKED_LABEL } from './snapshot.js'
import { StatsService } from './stats.js'
import { TrackingService } from './tracking.js'

let store: Store
let snapshot: SnapshotService
let tracking: TrackingService

beforeEach(() => {
  store = openStore(':memory:')
  tracking = new TrackingService(store)
  snapshot = new SnapshotService(store, new StatsService(store))
  // Stage shares with the supervisor by default (migration 004); the others do not.
})

const task = (title: string, areaId: string | null, projectId?: string): string =>
  store.tasks.create({ title, areaId, projectId: projectId ?? null }).id

describe('what the supervisor may see', () => {
  it('reports the running task when its area and project both allow it', () => {
    const project = store.projects.create({ name: 'SDSS', shareable: true, areaId: SYSTEM_AREAS.stage })
    tracking.startRun(task('Analyse data', SYSTEM_AREAS.stage, project.id))

    const payload = snapshot.build()

    expect(payload.tracking).toBe(true)
    expect(payload.currentTask).toBe('Analyse data')
    expect(payload.currentProject).toBe('SDSS')
  })

  it('masks a task whose project is not shareable, without losing the fact that work is happening', () => {
    const project = store.projects.create({ name: 'Secret', shareable: false, areaId: SYSTEM_AREAS.stage })
    tracking.startRun(task('Something private', SYSTEM_AREAS.stage, project.id))

    const payload = snapshot.build()

    expect(payload.tracking).toBe(true)
    expect(payload.currentTask).toBe(MASKED_LABEL)
    expect(payload.currentProject).toBeNull()
  })

  it('never reports private work as tracking at all', () => {
    tracking.startRun(task('Personal errand', SYSTEM_AREAS.personal))

    const payload = snapshot.build()

    expect(payload.tracking).toBe(false)
    expect(payload.currentTask).toBeNull()
    expect(payload.currentProject).toBeNull()
  })

  it('treats a task with no area as not shareable', () => {
    const id = task('Unassigned', null)
    tracking.startRun(id)
    // Nothing counts as stage hours without an area, so this reads as idle either way —
    // and the name must not appear even if that ever changes.
    expect(snapshot.build().currentTask).toBeNull()
  })

  it('does not let a shareable project widen what its area allows', () => {
    // The project says yes, the area says no. The more private of the two wins.
    const project = store.projects.create({ name: 'Side job', shareable: true, areaId: SYSTEM_AREAS.work })
    const id = task('Paid work', SYSTEM_AREAS.work, project.id)
    store.areas.update(SYSTEM_AREAS.work, { countsAsStageHours: true })
    tracking.startRun(id)

    const payload = snapshot.build()

    expect(payload.tracking).toBe(true)
    expect(payload.currentTask).toBe(MASKED_LABEL)
  })
})

describe('the numbers', () => {
  it('counts stage hours and leaves private time out entirely', () => {
    const start = Date.now() - 120 * MINUTE_MS
    tracking.startRun(task('Internship work', SYSTEM_AREAS.stage), start)
    tracking.switchTask(task('Personal errand', SYSTEM_AREAS.personal), start + 60 * MINUTE_MS)
    tracking.stopRun(start + 120 * MINUTE_MS)

    const payload = snapshot.build()

    expect(payload.weekStageMin).toBe(60)
    expect(payload.todayStageMin).toBe(60)
    // The private hour appears nowhere in the payload.
    expect(JSON.stringify(payload)).not.toContain('Personal errand')
  })

  it('takes planned minutes from the accepted day plan, not from the frozen table', () => {
    const id = task('Planned work', SYSTEM_AREAS.stage)
    const today = new Date()
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

    const draft = store.plans.createDraft({ scope: 'day', periodKey: date })
    store.plans.addBlock(draft.id, { taskId: id, date, startMin: 9 * 60, endMin: 11 * 60 })
    store.plans.accept(draft.id)

    expect(snapshot.build().weekPlannedMin).toBe(120)
  })

  it('counts only tasks the supervisor may see', () => {
    task('Open internship task', SYSTEM_AREAS.stage)
    task('Open private task', SYSTEM_AREAS.personal)

    expect(snapshot.build().openTasks).toBe(1)
  })

  it('never carries an image, a path or a note', () => {
    const start = Date.now() - 30 * MINUTE_MS
    tracking.startRun(task('Internship work', SYSTEM_AREAS.stage), start)
    tracking.stopRun(start + 30 * MINUTE_MS, 'a note that is nobody else’s business')

    const serialised = JSON.stringify(snapshot.build())

    expect(serialised).not.toContain('note')
    expect(serialised).not.toContain('.jpg')
    expect(serialised).not.toContain('path')
  })
})
