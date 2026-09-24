/**
 * The planner's guarantees, as tests.
 *
 * These are the cases from the specification: what may never be moved, what may never be
 * scheduled, and what must be scheduled early enough to still be possible. A scheduler
 * without these is just a sorting function with opinions.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { openStore, type Store } from '../../db/index.js'
import { PlannerService } from './index.js'
import { DependencyGraph } from './dependency-graph.js'
import { remainingEffort, splitIntoBlocks } from './remaining-effort.js'
import { buildDayWindow } from './availability.js'
import { diffPlans } from './plan-diff.js'
import { splitForReplan } from './replan.js'
import { DependencyCycleError } from '../../db/repositories/dependencies.js'
import { SYSTEM_AREAS, type PlanBlock, type PlanningProfile } from '../../contract/types.js'
import { toIsoDate, addDays } from '../../util/time.js'

let store: Store
let planner: PlannerService
let today: string
let tomorrow: string

const PROFILE: PlanningProfile = {
  id: 'balanced',
  name: 'Balanced',
  bufferPercentage: 12,
  minimumBlockMin: 25,
  preferredBlockMin: 90,
  maximumBlockMin: 120,
  discoveryBlockMin: 60,
  isDefault: true
}

beforeEach(() => {
  store = openStore(':memory:')
  planner = new PlannerService(store)
  today = toIsoDate(Date.now())
  tomorrow = toIsoDate(addDays(Date.now(), 1))

  // A generous, empty working day so scheduling is not squeezed by accident.
  store.availability.upsert({
    week: null,
    weekday: ((new Date().getDay() + 6) % 7) + 1,
    startMin: 8 * 60,
    endMin: 18 * 60,
    allowedAreas: [],
    areaTargets: {},
    enabled: true,
    // The whole day is internship time here, so these tests stay about ranking and fit.
    stageStartMin: 8 * 60,
    stageEndMin: 18 * 60
  })
})

const task = (title: string, fields: Partial<Parameters<Store['tasks']['create']>[0]> = {}) =>
  store.tasks.create({ title, areaId: SYSTEM_AREAS.stage, estimateMin: 60, ...fields })

const titlesIn = (blocks: Array<{ taskId?: string | null }>): string[] =>
  blocks.map((block) => (block.taskId ? (store.tasks.get(block.taskId)?.title ?? '?') : '?'))

// ------------------------------------------------------------ dependencies

describe('dependencies', () => {
  it('a hard dependency keeps a task out of the plan entirely', () => {
    const prerequisite = task('Collect data')
    const dependent = task('Analyse data')
    store.dependencies.add(dependent.id, prerequisite.id, 'hard')

    const proposal = planner.proposeDay(today)

    expect(titlesIn(proposal.blocks)).not.toContain('Analyse data')
    expect(proposal.excluded.map((e) => e.task.title)).toContain('Analyse data')
    expect(proposal.excluded.find((e) => e.task.title === 'Analyse data')?.reason).toBe(
      'waiting-on-dependency'
    )
  })

  it('a finished prerequisite releases the dependent task', () => {
    const prerequisite = task('Collect data')
    const dependent = task('Analyse data')
    store.dependencies.add(dependent.id, prerequisite.id, 'hard')
    store.tasks.complete(prerequisite.id, true)

    expect(titlesIn(planner.proposeDay(today).blocks)).toContain('Analyse data')
  })

  it('a preferred dependency does not block, it only nudges the order', () => {
    const first = task('Nice to do first', { priority: 'low' })
    const second = task('Dependent', { priority: 'low' })
    store.dependencies.add(second.id, first.id, 'preferred')

    const proposal = planner.proposeDay(today)
    expect(titlesIn(proposal.blocks)).toContain('Dependent')
    expect(proposal.excluded.map((e) => e.task.title)).not.toContain('Dependent')
  })

  it('a dependency cycle is rejected before it can be stored', () => {
    const a = task('A')
    const b = task('B')
    store.dependencies.add(b.id, a.id)

    expect(() => store.dependencies.add(a.id, b.id)).toThrow(DependencyCycleError)
  })

  it('unlocking several downstream tasks raises a task up the ranking', () => {
    const root = task('Unlocks things', { priority: 'low' })
    const a = task('Waiting A', { priority: 'low' })
    const b = task('Waiting B', { priority: 'low' })
    const plain = task('Unlocks nothing', { priority: 'low' })
    store.dependencies.add(a.id, root.id)
    store.dependencies.add(b.id, root.id)

    const ranked = planner.proposeDay(today).ranked
    const rootRank = ranked.findIndex((entry) => entry.task.id === root.id)
    const plainRank = ranked.findIndex((entry) => entry.task.id === plain.id)

    expect(rootRank).toBeLessThan(plainRank)
  })

  it('orders prerequisites before the tasks that need them', () => {
    const first = task('First')
    const second = task('Second')
    store.dependencies.add(second.id, first.id, 'preferred')

    const graph = new DependencyGraph(store.tasks.list(), store.dependencies.all())
    const ordered = graph.inDependencyOrder(store.tasks.list()).map((entry) => entry.title)

    expect(ordered.indexOf('First')).toBeLessThan(ordered.indexOf('Second'))
  })
})

// ------------------------------------------------------- estimates & dates

describe('estimates and dates', () => {
  it('a task with no due date can still be planned', () => {
    task('No deadline at all', { dueDate: null })
    expect(titlesIn(planner.proposeDay(today).blocks)).toContain('No deadline at all')
  })

  it('an unknown estimate gets a discovery block, not an invented duration', () => {
    const unknown = task('Unknown size', { estimateMin: null })
    const effort = remainingEffort(store.tasks.get(unknown.id)!, PROFILE)

    expect(effort.remainingMin).toBeNull()
    expect(effort.isDiscovery).toBe(true)
    expect(effort.scheduleMin).toBe(PROFILE.discoveryBlockMin)

    const block = planner.proposeDay(today).blocks.find((b) => b.taskId === unknown.id)!
    expect(block.endMin - block.startMin).toBe(PROFILE.discoveryBlockMin)
  })

  it('does not schedule a task that cannot be started yet', () => {
    task('Data arrives later', { earliestStartDate: tomorrow })

    const proposal = planner.proposeDay(today)
    expect(titlesIn(proposal.blocks)).not.toContain('Data arrives later')
    expect(proposal.excluded.find((e) => e.task.title === 'Data arrives later')?.reason).toBe(
      'not-startable-yet'
    )
  })

  it('starts an urgent long task today instead of leaving it to its deadline', () => {
    task('Six hour job due tomorrow', { estimateMin: 360, dueDate: tomorrow, priority: 'medium' })
    task('Comfortable job', { estimateMin: 60, dueDate: null, priority: 'medium' })

    const proposal = planner.proposeDay(today)
    const first = proposal.blocks[0]!

    expect(store.tasks.get(first.taskId!)!.title).toBe('Six hour job due tomorrow')
    // And it gets real time today, not a token slot.
    const minutes = proposal.blocks
      .filter((block) => store.tasks.get(block.taskId!)?.title === 'Six hour job due tomorrow')
      .reduce((sum, block) => sum + (block.endMin - block.startMin), 0)
    expect(minutes).toBeGreaterThanOrEqual(120)
  })

  it('splits long work into focus blocks rather than one unbroken slab', () => {
    const blocks = splitIntoBlocks(300, PROFILE)
    expect(blocks.length).toBeGreaterThan(1)
    expect(Math.max(...blocks)).toBeLessThanOrEqual(PROFILE.maximumBlockMin)
    expect(Math.min(...blocks)).toBeGreaterThanOrEqual(PROFILE.minimumBlockMin)
    expect(blocks.reduce((sum, block) => sum + block, 0)).toBe(300)
  })

  it('counts time already logged against the estimate', () => {
    const partly = task('Half done', { estimateMin: 120 })
    const run = store.tracking.startRun(Date.now() - 60 * 60_000)
    const segment = store.tracking.startSegment({
      trackingRunId: run.id,
      taskId: partly.id,
      areaId: SYSTEM_AREAS.stage,
      countsAsStageHours: true,
      at: Date.now() - 60 * 60_000
    })
    store.tracking.endSegment(segment.id, Date.now())

    expect(remainingEffort(store.tasks.get(partly.id)!, PROFILE).remainingMin).toBe(60)
  })
})

// ------------------------------------------------------- windows & buffer

describe('the shape of the day', () => {
  it('never schedules over a fixed meeting', () => {
    store.availability.addEvent({
      date: today,
      startMin: 10 * 60,
      endMin: 11 * 60,
      title: 'Supervisor meeting',
      kind: 'meeting',
      areaId: null,
      recurring: false
    })
    task('Something long', { estimateMin: 300 })

    for (const block of planner.proposeDay(today).blocks) {
      const overlaps = block.startMin < 11 * 60 && block.endMin > 10 * 60
      expect(overlaps).toBe(false)
    }
  })

  it('keeps a buffer rather than filling every free minute', () => {
    for (let i = 0; i < 12; i++) task(`Filler ${i}`, { estimateMin: 120, priority: 'medium' })

    const proposal = planner.proposeDay(today)
    expect(proposal.bufferMin).toBeGreaterThan(0)
    expect(proposal.plannedMin).toBeLessThanOrEqual(proposal.availableMin)
    expect(proposal.unplaced.length).toBeGreaterThan(0)
  })

  it('a tighter intensity leaves less slack than a relaxed one', () => {
    for (let i = 0; i < 12; i++) task(`Filler ${i}`, { estimateMin: 120 })

    const relaxed = planner.proposeDay(today, { intensity: 'relaxed' })
    const full = planner.proposeDay(today, { intensity: 'full' })

    expect(full.bufferMin).toBeLessThan(relaxed.bufferMin)
    expect(full.plannedMin).toBeGreaterThanOrEqual(relaxed.plannedMin)
  })

  it('reports gaps around what is already placed', () => {
    const window = buildDayWindow({
      date: today,
      availability: null,
      events: [],
      existing: [
        { startMin: 600, endMin: 660 } as PlanBlock,
        { startMin: 780, endMin: 840 } as PlanBlock
      ],
      intensity: 'balanced',
      fallback: { startMin: 540, endMin: 1020 }
    })

    expect(window.gaps.map((gap) => [gap.startMin, gap.endMin])).toEqual([
      [540, 600],
      [660, 780],
      [840, 1020]
    ])
  })
})

// -------------------------------------------------------------- replanning

describe('replanning', () => {
  const block = (id: string, fields: Partial<PlanBlock>): PlanBlock =>
    ({
      id,
      planId: 'p',
      taskId: 't',
      taskTitle: id,
      areaId: null,
      projectName: null,
      projectColor: null,
      date: today,
      startMin: 540,
      endMin: 600,
      kind: 'task',
      title: null,
      fixed: false,
      locked: false,
      source: 'planner',
      originalBlockId: null,
      explanation: null,
      score: null,
      ...fields
    }) as PlanBlock

  it('leaves the past, the running block and locked blocks alone', () => {
    const split = splitForReplan({
      nowMin: 12 * 60,
      blocks: [
        block('past', { startMin: 540, endMin: 600 }),
        block('running', { startMin: 700, endMin: 780 }),
        block('locked', { startMin: 840, endMin: 900, locked: true }),
        block('fixed', { startMin: 900, endMin: 960, fixed: true }),
        block('future', { startMin: 960, endMin: 1020 })
      ]
    })

    expect(split.keep.map((entry) => entry.id).sort()).toEqual([
      'fixed',
      'locked',
      'past',
      'running'
    ])
    expect(split.movable.map((entry) => entry.id)).toEqual(['future'])
  })

  it('only touches future blocks when replanning the rest of the day', () => {
    task('Morning work')
    const draft = store.plans.createDraft({ scope: 'day', periodKey: today })
    const morning = store.plans.addBlock(draft.id, {
      taskId: store.tasks.list()[0]!.id,
      date: today,
      startMin: 8 * 60,
      endMin: 9 * 60
    })
    store.plans.accept(draft.id)

    const proposal = planner.replanRestOfDay(today, 12 * 60)

    expect(proposal.kept.map((entry) => entry.id)).toContain(morning.id)
    for (const placed of proposal.blocks) expect(placed.startMin).toBeGreaterThanOrEqual(12 * 60)
  })
})

// -------------------------------------------------------------------- diff

describe('plan diff', () => {
  const make = (id: string, fields: Partial<PlanBlock>): PlanBlock =>
    ({
      id,
      planId: 'p',
      taskId: 't',
      taskTitle: 'Model training',
      date: today,
      startMin: 540,
      endMin: 600,
      kind: 'task',
      fixed: false,
      locked: false,
      source: 'planner',
      originalBlockId: null,
      ...fields
    }) as PlanBlock

  it('reports a shifted block as a move, not as a delete plus an add', () => {
    const before = [make('a', { startMin: 600, endMin: 660 })]
    const after = [make('b', { startMin: 780, endMin: 840, originalBlockId: 'a' })]

    const changes = diffPlans(before, after)
    expect(changes).toHaveLength(1)
    expect(changes[0]!.kind).toBe('move')
    expect(changes[0]!.explanation).toContain('10:00')
    expect(changes[0]!.explanation).toContain('13:00')
  })

  it('reports a longer block as a resize', () => {
    const before = [make('a', { startMin: 600, endMin: 660 })]
    const after = [make('b', { startMin: 600, endMin: 720, originalBlockId: 'a' })]

    const changes = diffPlans(before, after)
    expect(changes[0]!.kind).toBe('resize')
    expect(changes[0]!.explanation).toContain('extended')
  })

  it('reports additions and removals', () => {
    expect(diffPlans([], [make('new', {})])[0]!.kind).toBe('add')
    expect(diffPlans([make('gone', {})], [])[0]!.kind).toBe('remove')
  })

  it('says nothing changed when nothing changed', () => {
    const blocks = [make('a', {})]
    expect(diffPlans(blocks, blocks)).toHaveLength(0)
  })
})

// ------------------------------------------------------------ explanations

describe('explanations', () => {
  it('gives every scheduled block a reason', () => {
    task('Due tomorrow', { dueDate: tomorrow, priority: 'high' })

    for (const block of planner.proposeDay(today).blocks) {
      expect(block.explanation).toBeTruthy()
      expect(block.explanation).toContain('Recommended score')
    }
  })

  it('explains why a task was left out', () => {
    const prerequisite = task('Prerequisite')
    const dependent = task('Dependent')
    store.dependencies.add(dependent.id, prerequisite.id, 'hard')

    const excluded = planner
      .proposeDay(today)
      .excluded.find((entry) => entry.task.title === 'Dependent')!

    expect(excluded.explanation).toMatch(/waiting on/i)
  })

  it('does not mutate the accepted plan while proposing', () => {
    task('Something')
    const draft = store.plans.createDraft({ scope: 'day', periodKey: today })
    store.plans.addBlock(draft.id, {
      taskId: store.tasks.list()[0]!.id,
      date: today,
      startMin: 600,
      endMin: 660
    })
    store.plans.accept(draft.id)

    const before = store.plans.blocks(store.plans.accepted('day', today)!.id)
    planner.proposeDay(today)
    const after = store.plans.blocks(store.plans.accepted('day', today)!.id)

    expect(after).toEqual(before)
  })
})
