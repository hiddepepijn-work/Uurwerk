import { beforeEach, describe, expect, it } from 'vitest'
import { openStore, type Store } from '../db/index.js'
import { NO_PUBLISH, SYSTEM_AREAS, type PublishFlags } from '../contract/types.js'
import { MINUTE_MS, toIsoDate } from '../util/time.js'
import { DayReviewService } from './day-review.js'
import { MASKED_LABEL, PublishService, remoteName } from './publish.js'
import { TrackingService } from './tracking.js'

let store: Store
let publish: PublishService
let tracking: TrackingService
let today: string

beforeEach(() => {
  store = openStore(':memory:')
  tracking = new TrackingService(store)
  publish = new PublishService(store, new DayReviewService(store))
  today = toIsoDate(Date.now())
})

const flags = (overrides: Partial<PublishFlags> = {}): PublishFlags => ({
  ...NO_PUBLISH,
  ...overrides
})

const task = (title: string, areaId: string | null, projectId?: string): string =>
  store.tasks.create({ title, areaId, projectId: projectId ?? null }).id

function frame(options: { included: boolean }): string {
  return store.artifacts.add({
    day: today,
    kind: 'screenshot',
    path: `C:/frames/${options.included ? 'yes' : 'no'}.jpg`,
    included: options.included
  }).id
}

describe('the gate is closed by default', () => {
  it('publishes nothing at all when no category is ticked', () => {
    store.days.saveSummary(today, 'A whole day of work')
    frame({ included: true })

    const { payload, files } = publish.prepare(today)

    expect(publish.hasAnythingToPublish(today)).toBe(false)
    expect(files).toHaveLength(0)
    expect(payload.summary).toBeUndefined()
    expect(payload.trackedMin).toBeUndefined()
    expect(payload.screenshots).toBeUndefined()
    // Only the two fields that identify the day itself.
    expect(Object.keys(payload).sort()).toEqual(['date', 'publishedAt'])
  })

  it('never uploads a frame that was not approved, even with the category ticked', () => {
    store.days.saveFlags(today, flags({ screenshots: true }))
    const approved = frame({ included: true })
    frame({ included: false })

    const { files, payload } = publish.prepare(today)

    expect(files.map((file) => file.artifactId)).toEqual([approved])
    expect(payload.screenshots).toHaveLength(1)
  })

  it('leaves an empty summary out rather than publishing a blank block', () => {
    store.days.saveFlags(today, flags({ summary: true }))
    store.days.saveSummary(today, '   ')

    expect(publish.prepare(today).payload.summary).toBeUndefined()
  })
})

describe('what the numbers say', () => {
  it('counts stage hours only', () => {
    store.days.saveFlags(today, flags({ sessions: true }))
    const start = Date.now() - 90 * MINUTE_MS

    tracking.startRun(task('Internship work', SYSTEM_AREAS.stage), start)
    tracking.switchTask(task('Personal errand', SYSTEM_AREAS.personal), start + 60 * MINUTE_MS)
    tracking.stopRun(start + 90 * MINUTE_MS)

    expect(publish.prepare(today).payload.trackedMin).toBe(60)
  })

  it('masks work the supervisor may not see, keeping its minutes', () => {
    store.days.saveFlags(today, flags({ tasks: true }))
    const secret = store.projects.create({ name: 'Confidential', shareable: false, areaId: SYSTEM_AREAS.stage })
    const start = Date.now() - 60 * MINUTE_MS

    tracking.startRun(task('Secret work', SYSTEM_AREAS.stage, secret.id), start)
    tracking.stopRun(start + 60 * MINUTE_MS)

    const activities = publish.prepare(today).payload.activities!

    expect(activities).toEqual([{ title: MASKED_LABEL, minutes: 60 }])
    expect(JSON.stringify(activities)).not.toContain('Secret work')
  })

  it('keeps private time out of the activity list entirely', () => {
    store.days.saveFlags(today, flags({ tasks: true }))
    const start = Date.now() - 30 * MINUTE_MS

    tracking.startRun(task('Personal errand', SYSTEM_AREAS.personal), start)
    tracking.stopRun(start + 30 * MINUTE_MS)

    expect(publish.prepare(today).payload.activities).toEqual([])
  })

  it('names work that both its area and its project allow', () => {
    store.days.saveFlags(today, flags({ tasks: true }))
    const open = store.projects.create({ name: 'SDSS', shareable: true, areaId: SYSTEM_AREAS.stage })
    const start = Date.now() - 45 * MINUTE_MS

    tracking.startRun(task('Analyse data', SYSTEM_AREAS.stage, open.id), start)
    tracking.stopRun(start + 45 * MINUTE_MS)

    expect(publish.prepare(today).payload.activities).toEqual([
      { title: 'Analyse data', minutes: 45 }
    ])
  })
})

describe('remote names', () => {
  it('never carries the date, the local filename or an extension guess', () => {
    store.days.saveFlags(today, flags({ screenshots: true }))
    frame({ included: true })

    const [file] = publish.prepare(today).files

    expect(file!.remoteName).not.toContain(today)
    expect(file!.remoteName).not.toContain('yes')
    expect(file!.remoteName).toMatch(/^[a-f0-9]{32}\.jpg$/)
  })

  it('never writes a local path into the payload', () => {
    store.days.saveFlags(today, flags({ screenshots: true, summary: true }))
    store.days.saveSummary(today, 'Nothing to hide')
    frame({ included: true })

    const serialised = JSON.stringify(publish.prepare(today).payload)

    // The remote name legitimately ends in .jpg; what must never appear is where the file
    // lives on this machine — a drive letter, a folder, any separator at all.
    expect(serialised).not.toContain('C:/frames')
    expect(serialised).not.toMatch(/[a-zA-Z]:[/\\]/)
    expect(serialised).not.toMatch(/[/\\]/)
  })

  it('gives every upload a different name', () => {
    const names = new Set(Array.from({ length: 200 }, () => remoteName('jpg')))
    expect(names.size).toBe(200)
  })
})
