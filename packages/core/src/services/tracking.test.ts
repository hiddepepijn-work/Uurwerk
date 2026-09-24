import { beforeEach, describe, expect, it } from 'vitest'
import { openStore, type Store } from '../db/index.js'
import { TrackingService } from './tracking.js'
import { StatsService } from './stats.js'
import { SYSTEM_AREAS } from '../contract/types.js'
import { MINUTE_MS } from '../util/time.js'

let store: Store
let tracking: TrackingService
let stats: StatsService

beforeEach(() => {
  store = openStore(':memory:')
  tracking = new TrackingService(store)
  stats = new StatsService(store)
})

const stageTask = (title: string): string =>
  store.tasks.create({ title, areaId: SYSTEM_AREAS.stage }).id

const personalTask = (title: string): string =>
  store.tasks.create({ title, areaId: SYSTEM_AREAS.personal }).id

describe('runs and switching', () => {
  it('does not start tracking on its own', () => {
    // Opening the store is what happens at app startup. Nothing may begin counting.
    expect(tracking.isRunning()).toBe(false)
    expect(tracking.currentRun()).toBeNull()
    expect(tracking.currentSegment()).toBeNull()
  })

  it('switching keeps the run open and leaves no gap', () => {
    const a = stageTask('Task A')
    const b = stageTask('Task B')

    const start = Date.now() - 60 * MINUTE_MS
    tracking.startRun(a, start)
    const { segment } = tracking.switchTask(b, start + 30 * MINUTE_MS)

    const run = tracking.currentRun()!
    expect(run.segments).toHaveLength(2)
    expect(run.endedAt).toBeNull()
    expect(run.segments[0]!.endedAt).toBe(run.segments[1]!.startedAt)
    expect(run.segments[0]!.completionReason).toBe('switched')
    expect(segment.taskId).toBe(b)
  })

  it('switching to the task already running changes nothing', () => {
    const a = stageTask('Task A')
    const first = tracking.startRun(a)
    const { segment } = tracking.switchTask(a)

    expect(segment.id).toBe(first.id)
    expect(tracking.currentRun()!.segments).toHaveLength(1)
  })

  it('stopping closes both the segment and the run', () => {
    const a = stageTask('Task A')
    tracking.startRun(a)
    tracking.stopRun()

    expect(tracking.isRunning()).toBe(false)
    expect(tracking.currentSegment()).toBeNull()
  })

  it('starting work moves an open task to in progress', () => {
    const a = stageTask('Task A')
    tracking.startRun(a)
    expect(store.tasks.get(a)!.status).toBe('in_progress')
  })
})

describe('completing and blocking', () => {
  it('completes the current task and continues the run on the next one', () => {
    const a = stageTask('Finish this')
    const b = stageTask('Then this')
    tracking.startRun(a, Date.now() - 30 * MINUTE_MS)

    const { segment } = tracking.completeAndSwitch(b)

    expect(store.tasks.get(a)!.status).toBe('done')
    expect(store.tasks.get(a)!.completedAt).not.toBeNull()
    expect(segment.taskId).toBe(b)
    expect(tracking.currentRun()!.segments).toHaveLength(2)
    expect(tracking.currentRun()!.segments[0]!.completionReason).toBe('completed')
  })

  it('closes the previous segment even when it had no task', () => {
    // A segment with no task has nothing to complete, but it still has to be closed — two
    // open segments means the older one counts for ever without ever being the current one.
    const start = Date.now() - 30 * MINUTE_MS
    const loose = store.tasks.create({ title: 'No area' }).id
    store.tasks.update(loose, { areaId: null })
    tracking.startRun(loose, start)
    store.tracking.updateSegment(tracking.currentSegment()!.id, { taskId: null })

    const next = stageTask('Real work')
    tracking.completeAndSwitch(next, start + 20 * MINUTE_MS)

    expect(store.tracking.openSegments()).toHaveLength(1)
    expect(tracking.currentSegment()!.taskId).toBe(next)
  })

  it('leaves no gap between the completed segment and the next one', () => {
    const a = stageTask('Finish this')
    const b = stageTask('Then this')
    const start = Date.now() - 60 * MINUTE_MS

    tracking.startRun(a, start)
    tracking.completeAndSwitch(b, start + 25 * MINUTE_MS)

    const [first, second] = tracking.currentRun()!.segments
    expect(first!.endedAt).toBe(second!.startedAt)
  })

  it('blocks the current task with a reason and moves on', () => {
    const a = stageTask('Waiting on someone')
    const b = stageTask('Something else')
    tracking.startRun(a)

    tracking.blockAndSwitch('waiting for supervisor', b)

    const blocked = store.tasks.get(a)!
    expect(blocked.status).toBe('blocked')
    expect(blocked.blockedReason).toBe('waiting for supervisor')
  })
})

describe('stage hours', () => {
  it('does not count Work or Personal time as stage hours', () => {
    const stage = stageTask('Internship work')
    const personal = personalTask('Personal errand')

    const start = Date.now() - 120 * MINUTE_MS
    tracking.startRun(stage, start)
    tracking.switchTask(personal, start + 60 * MINUTE_MS)
    tracking.stopRun(start + 120 * MINUTE_MS)

    const totals = stats.totals(start - MINUTE_MS, Date.now())
    expect(totals.totalMin).toBe(120)
    expect(totals.stageMin).toBe(60)
    expect(totals.otherMin).toBe(60)
    expect(totals.byArea[SYSTEM_AREAS.personal]).toBe(60)
  })

  it('reports a switch that leaves stage hours, so the UI can confirm it', () => {
    const stage = stageTask('Internship work')
    const personal = personalTask('Personal errand')

    tracking.startRun(stage)
    expect(tracking.switchTask(personal).leavesStageHours).toBe(true)

    // Coming back the other way is not a warning — nothing is being lost.
    expect(tracking.switchTask(stage).leavesStageHours).toBe(false)
  })

  it('keeps old time classified as it was when the task moves to another area', () => {
    const task = stageTask('Was internship work')
    const start = Date.now() - 60 * MINUTE_MS
    tracking.startRun(task, start)
    tracking.stopRun(start + 60 * MINUTE_MS)

    // The task is reassigned afterwards — history must not follow it.
    store.tasks.update(task, { areaId: SYSTEM_AREAS.personal })

    const totals = stats.totals(start - MINUTE_MS, Date.now())
    expect(totals.stageMin).toBe(60)
    expect(totals.otherMin).toBe(0)
  })

  it('keeps old time classified as it was when the area itself is reclassified', () => {
    const task = personalTask('Personal errand')
    const start = Date.now() - 45 * MINUTE_MS
    tracking.startRun(task, start)
    tracking.stopRun(start + 45 * MINUTE_MS)

    store.areas.update(SYSTEM_AREAS.personal, { countsAsStageHours: true })

    const totals = stats.totals(start - MINUTE_MS, Date.now())
    expect(totals.stageMin).toBe(0)
    expect(totals.otherMin).toBe(45)
  })

  it('never counts a task with no area as stage hours', () => {
    const loose = store.tasks.create({ title: 'No area' }).id
    // Tasks default to no area unless a project supplies one.
    store.tasks.update(loose, { areaId: null })

    const start = Date.now() - 30 * MINUTE_MS
    tracking.startRun(loose, start)
    tracking.stopRun(start + 30 * MINUTE_MS)

    expect(stats.totals(start - MINUTE_MS, Date.now()).stageMin).toBe(0)
  })
})

describe('idle and repair', () => {
  it('ignores idle shorter than the timeout', () => {
    tracking.startRun(stageTask('Task'))
    expect(tracking.handleIdle(60, 5)).toBeNull()
    expect(tracking.isRunning()).toBe(true)
  })

  it('backdates the stop to when idling began', () => {
    const start = Date.now() - 60 * MINUTE_MS
    tracking.startRun(stageTask('Task'), start)

    const stopped = tracking.handleIdle(20 * 60, 5)!

    expect(stopped.durationMin).toBeGreaterThanOrEqual(39)
    expect(stopped.durationMin).toBeLessThanOrEqual(41)
    expect(stopped.autoStopped).toBe(true)
    expect(tracking.isRunning()).toBe(false)
  })

  it('still reports what was stopped when the segment was too short to keep', () => {
    // Resume the task, get a few seconds of input, go idle again: the backdated stop
    // lands within MIN_SEGMENT_MS of the start, so stopRun discards the segment. The
    // watchdog must still learn which task stopped, or it never re-arms the resume.
    const task = stageTask('Short burst')
    tracking.startRun(task, Date.now() - 10_000)

    const stopped = tracking.handleIdle(20 * 60, 5)

    expect(stopped).not.toBeNull()
    expect(stopped!.taskId).toBe(task)
    expect(tracking.isRunning()).toBe(false)
    // The mini segment itself stays discarded — only the report survives.
    expect(store.tracking.segmentsInRange(Date.now() - MINUTE_MS, Date.now())).toHaveLength(0)
  })

  it('caps a run left open by a crash rather than billing the whole gap', () => {
    const start = Date.now() - 40 * 60 * MINUTE_MS
    tracking.startRun(stageTask('Forgotten'), start)

    expect(tracking.repairOnStartup()).toBe(1)
    expect(tracking.isRunning()).toBe(false)

    const segment = store.tracking.segmentsInRange(start - MINUTE_MS, Date.now())[0]!
    expect(segment.durationMin).toBe(16 * 60)
  })

  it('leaves a normal running session alone at startup', () => {
    tracking.startRun(stageTask('Task'), Date.now() - 30 * MINUTE_MS)
    expect(tracking.repairOnStartup()).toBe(0)
    expect(tracking.isRunning()).toBe(true)
  })

  it('closes a segment left open behind a newer one', () => {
    const start = Date.now() - 90 * MINUTE_MS
    const run = store.tracking.startRun(start)

    // Exactly the shape a leaked switch leaves behind: two open segments in one run.
    const orphan = store.tracking.startSegment({
      trackingRunId: run.id,
      taskId: stageTask('Was left open'),
      areaId: SYSTEM_AREAS.stage,
      countsAsStageHours: true,
      at: start
    })
    store.tracking.startSegment({
      trackingRunId: run.id,
      taskId: stageTask('The live one'),
      areaId: SYSTEM_AREAS.stage,
      countsAsStageHours: true,
      at: start + 30 * MINUTE_MS
    })

    expect(tracking.repairOnStartup()).toBe(1)

    const closed = store.tracking.getSegment(orphan.id)!
    // Closed where the next segment began, so the half hour is counted once, not twice.
    expect(closed.endedAt).toBe(start + 30 * MINUTE_MS)
    expect(closed.durationMin).toBe(30)
    expect(store.tracking.openSegments()).toHaveLength(1)
    expect(tracking.isRunning()).toBe(true)
  })
})
