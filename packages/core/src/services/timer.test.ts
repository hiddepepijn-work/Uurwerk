import { beforeEach, describe, expect, it } from 'vitest'
import { openStore, type Store } from '../db/index.js'
import { TimerService } from './timer.js'
import { MINUTE_MS } from '../util/time.js'

let store: Store
let timer: TimerService
let taskId: string
let otherTaskId: string

beforeEach(() => {
  store = openStore(':memory:')
  timer = new TimerService(store)
  taskId = store.tasks.create({ title: 'Write tests' }).id
  otherTaskId = store.tasks.create({ title: 'Something else' }).id
})

describe('start and stop', () => {
  it('records a session and reports it as running', () => {
    const session = timer.start(taskId)
    expect(session.endedAt).toBeNull()
    expect(timer.isRunning()).toBe(true)
    expect(timer.current()?.id).toBe(session.id)
  })

  it('closes the session on stop and stores the note', () => {
    // Real timestamps: a segment abandoned within seconds is discarded as a mis-click.
    const startedAt = Date.now() - 30 * MINUTE_MS
    timer.start(taskId, startedAt)
    const stopped = timer.stop('did the thing', startedAt + 30 * MINUTE_MS)

    expect(stopped?.endedAt).not.toBeNull()
    expect(stopped?.note).toBe('did the thing')
    expect(timer.isRunning()).toBe(false)
  })

  it('discards a segment that was started and stopped within seconds', () => {
    const startedAt = Date.now() - 5000
    timer.start(taskId, startedAt)

    expect(timer.stop(undefined, startedAt + 5000)).toBeNull()
    expect(store.tracking.segmentsInRange(0, Date.now() + MINUTE_MS)).toHaveLength(0)
  })

  it('returns null when stopping with nothing running', () => {
    expect(timer.stop()).toBeNull()
  })

  it('never leaves two segments running at once', () => {
    const startedAt = Date.now() - 60 * MINUTE_MS
    timer.start(taskId, startedAt)
    timer.start(otherTaskId, startedAt + 30 * MINUTE_MS)

    const running = store.tracking
      .segmentsInRange(0, Date.now() + MINUTE_MS)
      .filter((s) => s.endedAt === null)
    expect(running).toHaveLength(1)
    expect(running[0]!.taskId).toBe(otherTaskId)
  })

  it('keeps one run open across a task switch instead of starting a second', () => {
    const startedAt = Date.now() - 60 * MINUTE_MS
    timer.start(taskId, startedAt)
    timer.start(otherTaskId, startedAt + 30 * MINUTE_MS)

    // The façade's "start another task" is a switch underneath: same run, two segments.
    const runs = store.tracking.runsInRange(0, Date.now() + MINUTE_MS)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.segments).toHaveLength(2)
    expect(runs[0]!.segments[0]!.endedAt).toBe(runs[0]!.segments[1]!.startedAt)
  })

  it('treats starting the already-running task as a no-op', () => {
    const first = timer.start(taskId)
    const second = timer.start(taskId)
    expect(second.id).toBe(first.id)
  })
})

describe('idle handling', () => {
  it('ignores idle shorter than the timeout', () => {
    timer.start(taskId)
    expect(timer.handleIdle(60, 5)).toBeNull()
    expect(timer.isRunning()).toBe(true)
  })

  it('backdates the stop to when idling began, so idle time is not billed', () => {
    const startedAt = Date.now() - 60 * MINUTE_MS
    timer.start(taskId, startedAt)

    // Idle for 20 minutes, noticed now.
    const stopped = timer.handleIdle(20 * 60, 5)

    expect(stopped).not.toBeNull()
    expect(stopped!.durationMin).toBeGreaterThanOrEqual(39)
    expect(stopped!.durationMin).toBeLessThanOrEqual(41)
    expect(stopped!.autoStopped).toBe(true)
  })

  it('never ends a session before it started', () => {
    // Idle for far longer than the session has existed: the backdated stop would land
    // before the start, so it is clamped rather than producing a negative duration.
    const startedAt = Date.now() - 45 * MINUTE_MS
    timer.start(taskId, startedAt)
    timer.handleIdle(60 * 60, 5)

    const segments = store.tracking.segmentsInRange(startedAt - MINUTE_MS, Date.now() + MINUTE_MS)
    for (const segment of segments) {
      expect(segment.endedAt).toBeGreaterThanOrEqual(segment.startedAt)
    }
  })
})

describe('startup repair', () => {
  it('leaves a normal running session alone', () => {
    timer.start(taskId, Date.now() - 30 * MINUTE_MS)
    expect(timer.repairOnStartup()).toBe(0)
    expect(timer.isRunning()).toBe(true)
  })

  it('caps a session left open by a crash instead of billing the whole gap', () => {
    const startedAt = Date.now() - 40 * 60 * MINUTE_MS
    timer.start(taskId, startedAt)

    expect(timer.repairOnStartup()).toBe(1)
    expect(timer.isRunning()).toBe(false)

    const repaired = store.tracking.segmentsInRange(startedAt - MINUTE_MS, Date.now())[0]!
    // Capped at 16 hours — over-reporting hours is the worse error.
    expect(repaired.durationMin).toBe(16 * 60)
    expect(repaired.autoStopped).toBe(true)
  })
})

describe('manual correction', () => {
  it('rejects an end before the start', () => {
    const session = timer.start(taskId)
    timer.stop()
    expect(() => timer.edit(session.id, { endedAt: session.startedAt - 1000 })).toThrow()
  })

  it('applies a corrected end time to the rollup', () => {
    const startedAt = Date.now() - 2 * 60 * MINUTE_MS
    const session = timer.start(taskId, startedAt)
    timer.stop(undefined, startedAt + 30 * MINUTE_MS)

    timer.edit(session.id, { endedAt: startedAt + 90 * MINUTE_MS })
    expect(store.tasks.get(taskId)!.loggedMin).toBe(90)
  })
})
