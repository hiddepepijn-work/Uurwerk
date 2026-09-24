/**
 * Repository tests for the planner model.
 *
 * These cover the guarantees the rest of the system is allowed to assume: dependency
 * cycles cannot be written, an accepted plan is never mutated in place, the baseline
 * survives revision, segments carry their own hour classification, and closing one
 * segment to open the next leaves no gap.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { openStore, type Store } from '../index.js'
import { DependencyCycleError } from './dependencies.js'
import { SYSTEM_AREAS } from '../../contract/types.js'

let store: Store

beforeEach(() => {
  store = openStore(':memory:')
})

const newTask = (title: string): string => store.tasks.create({ title }).id

// ------------------------------------------------------------------- areas

describe('areas', () => {
  it('seeds the system areas with their sharing rules', () => {
    const areas = store.areas.list()
    expect(areas.map((a) => a.id)).toEqual(['stage', 'work', 'personal', 'school'])

    const stage = store.areas.get(SYSTEM_AREAS.stage)!
    expect(stage.countsAsStageHours).toBe(true)
    expect(stage.defaultShareSupervisor).toBe(true)

    // Work is the same employer as Stage and shares none of its permissions.
    const work = store.areas.get(SYSTEM_AREAS.work)!
    expect(work.countsAsStageHours).toBe(false)
    expect(work.defaultShareSupervisor).toBe(false)

    const school = store.areas.get('school')!
    expect(school.countsAsStageHours).toBe(false)
    expect(school.defaultShareSupervisor).toBe(false)
    expect(school.defaultShareTeacher).toBe(true)
  })

  it('creates new areas private and non-counting by default', () => {
    const area = store.areas.create({ name: 'Study' })
    expect(area.countsAsStageHours).toBe(false)
    expect(area.defaultShareSupervisor).toBe(false)
    expect(area.defaultShareTeacher).toBe(false)
  })

  it('refuses to remove a built-in area', () => {
    expect(() => store.areas.archive(SYSTEM_AREAS.stage)).toThrow(/cannot be removed/i)
  })

  it('keeps supervisor and teacher sharing independent', () => {
    const area = store.areas.create({ name: 'School', defaultShareTeacher: true })
    expect(area.defaultShareTeacher).toBe(true)
    expect(area.defaultShareSupervisor).toBe(false)
  })
})

// ------------------------------------------------------------ dependencies

describe('dependencies', () => {
  it('records a dependency and reports it from both directions', () => {
    const a = newTask('Collect data')
    const b = newTask('Analyse data')
    store.dependencies.add(b, a, 'hard')

    expect(store.dependencies.forTask(b).map((d) => d.dependsOnTaskId)).toEqual([a])
    expect(store.dependencies.dependents(a).map((d) => d.taskId)).toEqual([b])
  })

  it('rejects a direct cycle', () => {
    const a = newTask('A')
    const b = newTask('B')
    store.dependencies.add(b, a)

    expect(() => store.dependencies.add(a, b)).toThrow(DependencyCycleError)
  })

  it('rejects an indirect cycle', () => {
    const a = newTask('A')
    const b = newTask('B')
    const c = newTask('C')
    store.dependencies.add(b, a)
    store.dependencies.add(c, b)

    expect(() => store.dependencies.add(a, c)).toThrow(DependencyCycleError)
  })

  it('rejects a task depending on itself', () => {
    const a = newTask('A')
    expect(() => store.dependencies.add(a, a)).toThrow(DependencyCycleError)
  })

  it('leaves the graph unchanged when a cycle is rejected', () => {
    const a = newTask('A')
    const b = newTask('B')
    store.dependencies.add(b, a)

    expect(() => store.dependencies.add(a, b)).toThrow()
    expect(store.dependencies.all()).toHaveLength(1)
  })

  it('treats an unfinished hard prerequisite as blocking', () => {
    const a = newTask('Prerequisite')
    const b = newTask('Dependent')
    store.dependencies.add(b, a, 'hard')

    expect(store.dependencies.unmetHardDependencies(b)).toHaveLength(1)

    store.tasks.complete(a, true)
    expect(store.dependencies.unmetHardDependencies(b)).toHaveLength(0)
  })

  it('does not treat a preferred dependency as blocking', () => {
    const a = newTask('Nice to do first')
    const b = newTask('Dependent')
    store.dependencies.add(b, a, 'preferred')

    expect(store.dependencies.unmetHardDependencies(b)).toHaveLength(0)
    expect(store.dependencies.forTask(b)).toHaveLength(1)
  })

  it('counts the whole downstream chain as unlock value', () => {
    const root = newTask('Root')
    const mid = newTask('Middle')
    const leafA = newTask('Leaf A')
    const leafB = newTask('Leaf B')
    store.dependencies.add(mid, root)
    store.dependencies.add(leafA, mid)
    store.dependencies.add(leafB, mid)

    // Middle, plus both leaves that middle unblocks.
    expect(store.dependencies.unlockValue(root)).toBe(3)
    expect(store.dependencies.unlockValue(leafA)).toBe(0)
  })

  it('replaces the whole set for a task atomically', () => {
    const a = newTask('A')
    const b = newTask('B')
    const c = newTask('C')
    store.dependencies.setForTask(c, [
      { dependsOnTaskId: a, type: 'hard' },
      { dependsOnTaskId: b, type: 'preferred' }
    ])
    expect(store.dependencies.forTask(c)).toHaveLength(2)

    store.dependencies.setForTask(c, [{ dependsOnTaskId: a, type: 'hard' }])
    expect(store.dependencies.forTask(c)).toHaveLength(1)
  })
})

// -------------------------------------------------------------------- plans

describe('plans', () => {
  const WEEK = '2026-W32'

  it('accepts a draft and reports it as the plan in force', () => {
    const draft = store.plans.createDraft({ scope: 'week', periodKey: WEEK })
    expect(store.plans.accepted('week', WEEK)).toBeNull()

    store.plans.accept(draft.id)
    expect(store.plans.accepted('week', WEEK)?.id).toBe(draft.id)
  })

  /**
   * Finding planning that counts for nothing.
   *
   * A draft reaches no total, no grid and no report, so one left behind is work that
   * silently did not happen. Nothing in the app could see that until this existed.
   */
  describe('drafts nothing is reading', () => {
    const dayDraft = (date: string, blocks: number): string => {
      const draft = store.plans.createDraft({ scope: 'day', periodKey: date })
      for (let index = 0; index < blocks; index++) {
        store.plans.addBlock(draft.id, {
          date,
          startMin: 9 * 60 + index * 60,
          endMin: 10 * 60 + index * 60,
          kind: 'task',
          title: `Block ${index}`
        })
      }
      return draft.id
    }

    it('lists a draft with work in it', () => {
      dayDraft('2026-08-04', 2)

      const pending = store.plans.pendingDrafts()
      expect(pending).toHaveLength(1)
      expect(pending[0]!.periodKey).toBe('2026-08-04')
      expect(pending[0]!.blockCount).toBe(2)
      expect(pending[0]!.plannedMin).toBe(120)
    })

    it('ignores an empty draft, which is just a planner someone opened and closed', () => {
      store.plans.createDraft({ scope: 'day', periodKey: '2026-08-04' })
      expect(store.plans.pendingDrafts()).toHaveLength(0)
    })

    it('stops listing one once it is accepted', () => {
      const id = dayDraft('2026-08-04', 1)
      expect(store.plans.pendingDrafts()).toHaveLength(1)

      store.plans.accept(id)
      expect(store.plans.pendingDrafts()).toHaveLength(0)
    })

    it('says when accepting would replace a plan already in force', () => {
      const first = dayDraft('2026-08-04', 1)
      store.plans.accept(first)
      dayDraft('2026-08-04', 2)

      const pending = store.plans.pendingDrafts()
      expect(pending).toHaveLength(1)
      expect(pending[0]!.replacesAccepted).toBe(true)
    })

    it('says when it would be the first plan for that day', () => {
      dayDraft('2026-08-04', 1)
      expect(store.plans.pendingDrafts()[0]!.replacesAccepted).toBe(false)
    })

    it('counts only task time, not the breaks around it', () => {
      const draft = store.plans.createDraft({ scope: 'day', periodKey: '2026-08-04' })
      store.plans.addBlock(draft.id, {
        date: '2026-08-04',
        startMin: 9 * 60,
        endMin: 10 * 60,
        kind: 'task'
      })
      store.plans.addBlock(draft.id, {
        date: '2026-08-04',
        startMin: 10 * 60,
        endMin: 10 * 60 + 30,
        kind: 'break',
        title: 'Break'
      })

      const pending = store.plans.pendingDrafts()[0]!
      expect(pending.blockCount).toBe(2)
      expect(pending.plannedMin).toBe(60)
    })

    it('stops listing one once it is thrown away', () => {
      const id = dayDraft('2026-08-04', 3)
      expect(store.plans.pendingDrafts()).toHaveLength(1)

      store.plans.discardDraft(id)

      expect(store.plans.pendingDrafts()).toHaveLength(0)
      expect(store.plans.get(id)).toBeNull()
      expect(store.plans.blocks(id)).toHaveLength(0)
    })

    it('refuses to throw away a plan that is in force', () => {
      const id = dayDraft('2026-08-04', 1)
      store.plans.accept(id)

      expect(() => store.plans.discardDraft(id)).toThrow(/only a draft/i)
      expect(store.plans.accepted('day', '2026-08-04')?.id).toBe(id)
    })

    it('keeps the hours that were tracked against a discarded block', () => {
      const draft = store.plans.createDraft({ scope: 'day', periodKey: '2026-08-04' })
      const block = store.plans.addBlock(draft.id, {
        date: '2026-08-04',
        startMin: 9 * 60,
        endMin: 10 * 60,
        kind: 'task'
      })

      const run = store.tracking.startRun(Date.parse('2026-08-04T09:00:00'))
      const segment = store.tracking.startSegment({
        trackingRunId: run.id,
        taskId: null,
        areaId: null,
        countsAsStageHours: false,
        planBlockId: block.id,
        at: Date.parse('2026-08-04T09:00:00')
      })

      store.plans.discardDraft(draft.id)

      // Unlinked, never deleted: throwing away an intention must not throw away the hours
      // you actually worked against it.
      const kept = store.tracking.getSegment(segment.id)
      expect(kept).not.toBeNull()
      expect(kept!.planBlockId).toBeNull()
    })

    /**
     * The difference that made "Discard draft" look broken: discarding falls back to the
     * plan the draft branched from, so a day you wanted rid of stayed exactly as planned.
     */
    describe('clearing a day rather than discarding a draft', () => {
      it('discarding falls back to the plan in force, leaving the day still planned', () => {
        const accepted = dayDraft('2026-08-24', 1)
        store.plans.accept(accepted)

        const working = store.plans.createDraft({ scope: 'day', periodKey: '2026-08-24' })
        store.plans.copyBlocks(accepted, working.id)
        store.plans.discardDraft(working.id)

        expect(store.plans.acceptedBlocksForDays(['2026-08-24'])).toHaveLength(1)
      })

      it('clearing leaves the day with nothing the week can read', () => {
        const accepted = dayDraft('2026-08-24', 3)
        store.plans.accept(accepted)

        store.plans.clearPeriod('day', '2026-08-24')

        expect(store.plans.acceptedBlocksForDays(['2026-08-24'])).toHaveLength(0)
        expect(store.plans.plannedMinutesForDays(['2026-08-24']).size).toBe(0)
      })

      it('keeps the baseline, so the report still knows what was intended', () => {
        const accepted = dayDraft('2026-08-24', 2)
        store.plans.accept(accepted)

        store.plans.clearPeriod('day', '2026-08-24')

        expect(store.plans.baseline('day', '2026-08-24')?.id).toBe(accepted)
        expect(store.plans.get(accepted)?.status).toBe('superseded')
      })

      it('takes the open working copy with it, leaving nothing pending', () => {
        const accepted = dayDraft('2026-08-24', 1)
        store.plans.accept(accepted)
        dayDraft('2026-08-24', 2)
        expect(store.plans.pendingDrafts()).toHaveLength(1)

        store.plans.clearPeriod('day', '2026-08-24')

        expect(store.plans.pendingDrafts()).toHaveLength(0)
        expect(store.plans.draft('day', '2026-08-24')).toBeNull()
      })

      it('clears a day that only ever had a draft, without inventing a plan', () => {
        dayDraft('2026-08-24', 2)

        store.plans.clearPeriod('day', '2026-08-24')

        expect(store.plans.draft('day', '2026-08-24')).toBeNull()
        expect(store.plans.accepted('day', '2026-08-24')).toBeNull()
        expect(store.plans.pendingDrafts()).toHaveLength(0)
      })

      it('is safe on a day that was never planned', () => {
        expect(() => store.plans.clearPeriod('day', '2026-08-24')).not.toThrow()
        expect(store.plans.accepted('day', '2026-08-24')).toBeNull()
      })

      it('can be replanned afterwards like any other day', () => {
        const accepted = dayDraft('2026-08-24', 1)
        store.plans.accept(accepted)
        store.plans.clearPeriod('day', '2026-08-24')

        const again = dayDraft('2026-08-24', 2)
        store.plans.accept(again)

        expect(store.plans.acceptedBlocksForDays(['2026-08-24'])).toHaveLength(2)
      })
    })

    it('orders them by day, so a fortnight reads in the order it happened', () => {
      dayDraft('2026-08-06', 1)
      dayDraft('2026-08-04', 1)
      dayDraft('2026-08-05', 1)

      expect(store.plans.pendingDrafts().map((row) => row.periodKey)).toEqual([
        '2026-08-04',
        '2026-08-05',
        '2026-08-06'
      ])
    })
  })

  it('supersedes the previous plan instead of deleting it', () => {
    const first = store.plans.createDraft({ scope: 'week', periodKey: WEEK })
    store.plans.accept(first.id)

    const second = store.plans.createDraft({ scope: 'week', periodKey: WEEK, reason: 'New task' })
    store.plans.accept(second.id)

    expect(store.plans.get(first.id)?.status).toBe('superseded')
    expect(store.plans.accepted('week', WEEK)?.id).toBe(second.id)
    expect(store.plans.history('week', WEEK)).toHaveLength(2)
  })

  it('keeps the baseline reachable after revisions', () => {
    const first = store.plans.createDraft({ scope: 'week', periodKey: WEEK })
    store.plans.accept(first.id)
    const second = store.plans.createDraft({ scope: 'week', periodKey: WEEK })
    store.plans.accept(second.id)
    const third = store.plans.createDraft({ scope: 'week', periodKey: WEEK })
    store.plans.accept(third.id)

    expect(store.plans.baseline('week', WEEK)?.id).toBe(first.id)
    expect(store.plans.accepted('week', WEEK)?.id).toBe(third.id)
  })

  it('never leaves two accepted plans for one period', () => {
    const first = store.plans.createDraft({ scope: 'week', periodKey: WEEK })
    store.plans.accept(first.id)
    const second = store.plans.createDraft({ scope: 'week', periodKey: WEEK })
    store.plans.accept(second.id)

    const accepted = store.plans
      .history('week', WEEK)
      .filter((plan) => plan.status === 'accepted')
    expect(accepted).toHaveLength(1)
  })

  it('links each revision to its parent and increments the version', () => {
    const first = store.plans.createDraft({ scope: 'week', periodKey: WEEK })
    store.plans.accept(first.id)
    const second = store.plans.createDraft({ scope: 'week', periodKey: WEEK })

    expect(second.version).toBe(2)
    expect(second.parentPlanId).toBe(first.id)
  })

  it('does not change an accepted plan when a draft revision is built from it', () => {
    const first = store.plans.createDraft({ scope: 'week', periodKey: WEEK })
    const task = newTask('Model training')
    store.plans.addBlock(first.id, { taskId: task, date: '2026-08-03', startMin: 540, endMin: 660 })
    store.plans.accept(first.id)

    const revision = store.plans.createDraft({ scope: 'week', periodKey: WEEK })
    store.plans.copyBlocks(first.id, revision.id)
    const copied = store.plans.blocks(revision.id)[0]!
    store.plans.updateBlock(copied.id, { startMin: 600, endMin: 720 })

    // The accepted plan still says what it always said.
    const original = store.plans.blocks(first.id)[0]!
    expect(original.startMin).toBe(540)
    expect(original.endMin).toBe(660)
    expect(store.plans.accepted('week', WEEK)?.id).toBe(first.id)
  })

  it('records where a copied block came from, so a diff can call it a move', () => {
    const first = store.plans.createDraft({ scope: 'week', periodKey: WEEK })
    const task = newTask('Documentation')
    const source = store.plans.addBlock(first.id, {
      taskId: task,
      date: '2026-08-03',
      startMin: 540,
      endMin: 600
    })
    store.plans.accept(first.id)

    const revision = store.plans.createDraft({ scope: 'week', periodKey: WEEK })
    const [copy] = store.plans.copyBlocks(first.id, revision.id)
    expect(copy!.originalBlockId).toBe(source.id)
  })

  it('refuses a block that ends before it starts', () => {
    const plan = store.plans.createDraft({ scope: 'day', periodKey: '2026-08-03' })
    expect(() =>
      store.plans.addBlock(plan.id, { date: '2026-08-03', startMin: 600, endMin: 540 })
    ).toThrow(/must end after/i)
  })

  it('refuses to discard an accepted plan', () => {
    const plan = store.plans.createDraft({ scope: 'week', periodKey: WEEK })
    store.plans.accept(plan.id)
    expect(() => store.plans.discardDraft(plan.id)).toThrow(/only a draft/i)
  })

  it('sums planned minutes per task from the accepted plan only', () => {
    const task = newTask('Analysis')
    const accepted = store.plans.createDraft({ scope: 'week', periodKey: WEEK })
    store.plans.addBlock(accepted.id, {
      taskId: task,
      date: '2026-08-03',
      startMin: 540,
      endMin: 660
    })
    store.plans.accept(accepted.id)

    // A draft revision must not leak into the totals.
    const draft = store.plans.createDraft({ scope: 'week', periodKey: WEEK })
    store.plans.addBlock(draft.id, { taskId: task, date: '2026-08-04', startMin: 540, endMin: 900 })

    expect(store.plans.plannedMinutesByTask('week', WEEK).get(task)).toBe(120)
  })
})

// ----------------------------------------------------------------- tracking

describe('tracking', () => {
  it('keeps a run open across a task switch, with adjacent segments', () => {
    const a = newTask('Task A')
    const b = newTask('Task B')
    const run = store.tracking.startRun(1000)

    const first = store.tracking.startSegment({
      trackingRunId: run.id,
      taskId: a,
      areaId: SYSTEM_AREAS.stage,
      countsAsStageHours: true,
      at: 1000
    })

    // Switching: one timestamp closes the old segment and opens the new one.
    const switchAt = 1000 + 30 * 60_000
    store.tracking.endSegment(first.id, switchAt, 'switched')
    const second = store.tracking.startSegment({
      trackingRunId: run.id,
      taskId: b,
      areaId: SYSTEM_AREAS.stage,
      countsAsStageHours: true,
      at: switchAt
    })

    const segments = store.tracking.segmentsForRun(run.id)
    expect(segments).toHaveLength(2)
    expect(segments[0]!.endedAt).toBe(segments[1]!.startedAt) // no gap, no overlap
    expect(store.tracking.currentRun()?.id).toBe(run.id)
    expect(store.tracking.currentSegment()?.id).toBe(second.id)
  })

  it('stamps the stage classification on the segment, not on the area lookup', () => {
    const task = newTask('Personal errand')
    const run = store.tracking.startRun()
    const segment = store.tracking.startSegment({
      trackingRunId: run.id,
      taskId: task,
      areaId: SYSTEM_AREAS.personal,
      countsAsStageHours: false
    })

    // Reclassifying the area afterwards must not rewrite what already happened.
    store.areas.update(SYSTEM_AREAS.personal, { countsAsStageHours: true })
    expect(store.tracking.getSegment(segment.id)!.countsAsStageHours).toBe(false)
  })

  it('reports segments overlapping a range, including one still running', () => {
    const task = newTask('Ongoing')
    const run = store.tracking.startRun(Date.now() - 60 * 60_000)
    store.tracking.startSegment({
      trackingRunId: run.id,
      taskId: task,
      areaId: SYSTEM_AREAS.stage,
      countsAsStageHours: true,
      at: Date.now() - 60 * 60_000
    })

    const found = store.tracking.segmentsInRange(Date.now() - 2 * 60 * 60_000, Date.now() + 1000)
    expect(found).toHaveLength(1)
    expect(found[0]!.endedAt).toBeNull()
    expect(found[0]!.durationMin).toBeGreaterThanOrEqual(59)
  })

  it('refuses a segment that ends before it starts', () => {
    const run = store.tracking.startRun()
    const segment = store.tracking.startSegment({
      trackingRunId: run.id,
      taskId: null,
      areaId: null,
      countsAsStageHours: false
    })
    expect(() =>
      store.tracking.updateSegment(segment.id, { endedAt: segment.startedAt - 1000 })
    ).toThrow(/cannot end before/i)
  })

  it('lists every open segment, oldest first, so an orphan can be found', () => {
    // Only the newest is ever returned as "current", so this is the only way a segment
    // left behind by a bad switch is visible at all. Startup repair depends on it.
    const run = store.tracking.startRun(1000)
    const first = store.tracking.startSegment({
      trackingRunId: run.id,
      taskId: null,
      areaId: null,
      countsAsStageHours: false,
      at: 1000
    })
    const second = store.tracking.startSegment({
      trackingRunId: run.id,
      taskId: null,
      areaId: null,
      countsAsStageHours: false,
      at: 2000
    })

    expect(store.tracking.openSegments().map((segment) => segment.id)).toEqual([
      first.id,
      second.id
    ])
    expect(store.tracking.currentSegment()!.id).toBe(second.id)
  })
})

// ------------------------------------------------------------- availability

describe('availability', () => {
  it('falls back to the recurring default for days a week does not override', () => {
    store.availability.upsert({
      week: null,
      weekday: 1,
      startMin: 510,
      endMin: 1020,
      allowedAreas: [],
      areaTargets: {},
      enabled: true,
      stageStartMin: 540,
      stageEndMin: 1080
    })
    store.availability.upsert({
      week: '2026-W32',
      weekday: 1,
      startMin: 600,
      endMin: 900,
      allowedAreas: [SYSTEM_AREAS.stage],
      areaTargets: { stage: 300 },
      enabled: true,
      stageStartMin: 600,
      stageEndMin: 900
    })

    const week = store.availability.forWeek('2026-W32')
    const monday = week.find((row) => row.weekday === 1)!
    expect(monday.startMin).toBe(600)
    expect(monday.areaTargets['stage']).toBe(300)
  })

  it('survives a corrupt JSON column rather than throwing', () => {
    const row = store.availability.upsert({
      week: null,
      weekday: 2,
      startMin: 540,
      endMin: 1020,
      allowedAreas: [],
      areaTargets: {},
      enabled: true,
      stageStartMin: 540,
      stageEndMin: 1020
    })
    store.db.run('UPDATE availability SET area_targets = ? WHERE id = ?', ['not json', row.id])

    expect(store.availability.defaults()[0]!.areaTargets).toEqual({})
  })

  it('stores fixed events and refuses a zero-length one', () => {
    store.availability.addEvent({
      date: '2026-08-03',
      startMin: 750,
      endMin: 780,
      title: 'Lunch',
      kind: 'break',
      areaId: null,
      recurring: false
    })
    expect(store.availability.eventsOn('2026-08-03')).toHaveLength(1)

    expect(() =>
      store.availability.addEvent({
        date: '2026-08-03',
        startMin: 600,
        endMin: 600,
        title: 'Nothing',
        kind: 'meeting',
        areaId: null,
        recurring: false
      })
    ).toThrow(/must end after/i)
  })

  it('returns the seeded balanced profile as the default', () => {
    const profile = store.availability.defaultProfile()
    expect(profile.id).toBe('balanced')
    expect(profile.bufferPercentage).toBe(12)
    expect(profile.minimumBlockMin).toBe(25)
    expect(profile.discoveryBlockMin).toBe(60)
  })
})
