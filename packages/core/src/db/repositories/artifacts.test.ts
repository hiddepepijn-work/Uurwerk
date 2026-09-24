import { beforeEach, describe, expect, it } from 'vitest'
import { openStore, type Store } from '../index.js'
import { atMinuteOfDay, toIsoDate, startOfIsoWeek } from '../../util/time.js'

let store: Store
let day: string

beforeEach(() => {
  store = openStore(':memory:')
  day = toIsoDate(startOfIsoWeek(Date.now()))
})

/** A closed segment on `day`, so a frame has something real to point at. */
function segmentFor(taskTitle: string): string {
  const task = store.tasks.create({ title: taskTitle })
  const run = store.tracking.startRun(atMinuteOfDay(day, 540))
  const segment = store.tracking.startSegment({
    trackingRunId: run.id,
    taskId: task.id,
    areaId: 'stage',
    countsAsStageHours: true,
    at: atMinuteOfDay(day, 540)
  })
  store.tracking.endSegment(segment.id, atMinuteOfDay(day, 600))
  store.tracking.endRun(run.id, atMinuteOfDay(day, 600))
  return segment.id
}

describe('screenshots', () => {
  it('is excluded by default — the approval gate is not opt-out', () => {
    const shot = store.artifacts.add({ day, kind: 'screenshot', path: 'C:/frames/a.jpg' })
    expect(shot.included).toBe(false)
  })

  it('links to the segment that was running, and reports its task', () => {
    const segmentId = segmentFor('Model training')
    const shot = store.artifacts.add({
      timeSegmentId: segmentId,
      day,
      kind: 'screenshot',
      path: 'C:/frames/a.jpg'
    })

    expect(shot.timeSegmentId).toBe(segmentId)
    expect(shot.taskTitle).toBe('Model training')
    expect(store.artifacts.listByDay(day, 'screenshot')[0]!.taskTitle).toBe('Model training')
  })

  it('accepts a frame with no segment — a manual grab while the timer is off', () => {
    const shot = store.artifacts.add({ day, kind: 'screenshot', path: 'C:/frames/b.jpg' })
    expect(shot.timeSegmentId).toBeNull()
    expect(shot.taskTitle).toBeNull()
  })

  it('approves and un-approves a whole day without touching other days or kinds', () => {
    store.artifacts.add({ day, kind: 'screenshot', path: 'C:/frames/a.jpg' })
    store.artifacts.add({ day, kind: 'screenshot', path: 'C:/frames/b.jpg' })
    store.artifacts.add({ day: '2020-01-01', kind: 'screenshot', path: 'C:/old/c.jpg' })
    store.artifacts.add({ day, kind: 'timelapse', path: 'C:/films/d.webm', included: true })

    expect(store.artifacts.setIncludedForDay(day, 'screenshot', true)).toBe(2)
    expect(store.artifacts.listByDay(day, 'screenshot').every((a) => a.included)).toBe(true)
    expect(store.artifacts.listByDay('2020-01-01', 'screenshot')[0]!.included).toBe(false)
    expect(store.artifacts.listByDay(day, 'timelapse')[0]!.included).toBe(true)

    store.artifacts.setIncludedForDay(day, 'screenshot', false)
    expect(store.artifacts.listByDay(day, 'screenshot').some((a) => a.included)).toBe(false)
  })

  it('keeps a frame when its segment is deleted rather than losing the image', () => {
    const segmentId = segmentFor('Doomed task')
    const shot = store.artifacts.add({
      timeSegmentId: segmentId,
      day,
      kind: 'screenshot',
      path: 'C:/frames/a.jpg'
    })

    store.tracking.removeSegment(segmentId)

    // ON DELETE SET NULL: editing your hours must not silently delete your screenshots.
    const after = store.artifacts.get(shot.id)
    expect(after).not.toBeNull()
    expect(after!.timeSegmentId).toBeNull()
  })

  it('only expires screenshots, never timelapses', () => {
    store.artifacts.add({ day: '2020-01-01', kind: 'screenshot', path: 'C:/old/a.jpg' })
    store.artifacts.add({ day: '2020-01-01', kind: 'timelapse', path: 'C:/old/b.webm' })

    const expired = store.artifacts.screenshotsOlderThan('2021-01-01')
    expect(expired).toHaveLength(1)
    expect(expired[0]!.kind).toBe('screenshot')
  })
})
