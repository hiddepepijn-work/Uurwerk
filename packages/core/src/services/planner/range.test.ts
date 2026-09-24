/**
 * Planning across days, with deadlines that mean something.
 *
 * The scenario these are built around is the real one: a document due on the 23rd, other
 * work due on the 28th, and a week that already has shifts in it. The question is never
 * "what should I do today" — it is "does this fit at all, and if not, by how much".
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { openStore, type Store } from '../../db/index.js'
import { SYSTEM_AREAS, SYSTEM_ORGANIZATIONS } from '../../contract/types.js'
import { PlannerService } from './index.js'

let store: Store
let planner: PlannerService

/** A fixed fortnight, so "the 23rd" is a date and not a moving target. */
const MONDAY = '2026-11-16'
const DUE_EARLY = '2026-11-23'
const DUE_LATE = '2026-11-28'
const END = '2026-11-29'

beforeEach(() => {
  store = openStore(':memory:')
  planner = new PlannerService(store)

  // A plain working week: eight hours a day, Monday to Friday, no weekend.
  for (let weekday = 1; weekday <= 5; weekday++) {
    store.availability.upsert({
      week: null,
      weekday,
      startMin: 9 * 60,
      endMin: 17 * 60,
      allowedAreas: [],
      areaTargets: {},
      enabled: true,
      // These tests are about deadlines and capacity, so the whole day is internship time.
      stageStartMin: 9 * 60,
      stageEndMin: 17 * 60
    })
  }
})

function task(title: string, estimateMin: number, dueDate?: string): string {
  return store.tasks.create({
    title,
    areaId: SYSTEM_AREAS.stage,
    estimateMin,
    ...(dueDate ? { dueDate } : {})
  }).id
}

const minutesFor = (proposal: { blocks: Array<{ taskId?: string | null; startMin: number; endMin: number }> }, id: string): number =>
  proposal.blocks
    .filter((block) => block.taskId === id)
    .reduce((sum, block) => sum + (block.endMin - block.startMin), 0)

describe('the deadline decides the order', () => {
  it('gives the hours before the 23rd to the task due on the 23rd', () => {
    const document = task('Finish the document', 6 * 60, DUE_EARLY)
    const later = task('Other work', 20 * 60, DUE_LATE)

    const proposal = planner.proposeRange(MONDAY, END)

    const documentBlocks = proposal.blocks.filter((block) => block.taskId === document)
    expect(documentBlocks.length).toBeGreaterThan(0)
    // Every minute of it lands on or before its due date.
    expect(documentBlocks.every((block) => block.date <= DUE_EARLY)).toBe(true)
    expect(minutesFor(proposal, document)).toBe(6 * 60)
    expect(minutesFor(proposal, later)).toBeGreaterThan(0)
  })

  it('never places work after its own due date', () => {
    task('Finish the document', 6 * 60, DUE_EARLY)
    const proposal = planner.proposeRange(MONDAY, END)

    for (const block of proposal.blocks) {
      const due = store.tasks.get(block.taskId!)?.dueDate
      if (due) expect(block.date <= due).toBe(true)
    }
  })

  it('lets an earlier deadline take the room even when a later task scores higher', () => {
    // High priority and a big estimate would win the day planner's ranking outright.
    const loud = store.tasks.create({
      title: 'Loud but later',
      areaId: SYSTEM_AREAS.stage,
      estimateMin: 30 * 60,
      priority: 'high',
      dueDate: DUE_LATE
    }).id
    const quiet = store.tasks.create({
      title: 'Quiet but sooner',
      areaId: SYSTEM_AREAS.stage,
      estimateMin: 4 * 60,
      priority: 'low',
      dueDate: DUE_EARLY
    }).id

    const proposal = planner.proposeRange(MONDAY, END)

    expect(minutesFor(proposal, quiet)).toBe(4 * 60)
    expect(proposal.shortfalls.some((entry) => entry.taskId === quiet)).toBe(false)
    expect(minutesFor(proposal, loud)).toBeGreaterThan(0)
  })
})

describe('when it does not fit', () => {
  it('reports a shortfall rather than quietly planning past the deadline', () => {
    // Forty hours of work, one week of eight-hour days before the deadline: it cannot fit
    // alongside anything else, and the plan must say so.
    const impossible = task('Far too much', 60 * 60, DUE_EARLY)

    const proposal = planner.proposeRange(MONDAY, END)
    const shortfall = proposal.shortfalls.find((entry) => entry.taskId === impossible)!

    expect(shortfall).toBeDefined()
    expect(shortfall.shortfallMin).toBeGreaterThan(0)
    expect(shortfall.requiredMin).toBe(60 * 60)
    // Nothing for it was scheduled after the due date.
    expect(
      proposal.blocks.filter((block) => block.taskId === impossible).every((b) => b.date <= DUE_EARLY)
    ).toBe(true)
  })

  it('offers both ways out: more hours per day, or a later date', () => {
    const impossible = task('Far too much', 50 * 60, DUE_EARLY)

    const shortfall = planner
      .proposeRange(MONDAY, END)
      .shortfalls.find((entry) => entry.taskId === impossible)!

    // Option one: free up this much per remaining working day and keep the 23rd.
    expect(shortfall.daysBeforeDue).toBeGreaterThan(0)
    expect(shortfall.extraMinPerDay).toBeGreaterThan(0)
    expect(shortfall.extraMinPerDay % 15).toBe(0)

    // Option two: move the deadline to a date the work can actually be done by.
    if (shortfall.earliestFinishDate) {
      expect(shortfall.earliestFinishDate > DUE_EARLY).toBe(true)
    }
  })

  it('says the work does not fit at all rather than inventing a date beyond the range', () => {
    task('Absurd', 500 * 60, DUE_EARLY)

    const shortfall = planner.proposeRange(MONDAY, END).shortfalls[0]!
    expect(shortfall.earliestFinishDate).toBeNull()
  })

  it('keeps a task with no deadline out of the shortfall list', () => {
    task('Someday', 200 * 60)

    const proposal = planner.proposeRange(MONDAY, END)
    expect(proposal.shortfalls).toHaveLength(0)
    expect(proposal.unplaced.length).toBeGreaterThan(0)
  })
})

describe('hours that are already spoken for', () => {
  it('plans around a standing shift', () => {
    // Every Wednesday at Jumbo, right through the working day.
    store.commitments.create({
      title: 'Jumbo shift',
      weekday: 3,
      startMin: 9 * 60,
      endMin: 17 * 60,
      kind: 'unavailable',
      areaId: SYSTEM_AREAS.work,
      organizationId: SYSTEM_ORGANIZATIONS.jumbo,
      activeFrom: MONDAY
    })

    task('Internship work', 30 * 60, DUE_LATE)
    const proposal = planner.proposeRange(MONDAY, END)

    // Wednesday the 18th and the 25th are gone entirely.
    expect(proposal.blocks.some((block) => block.date === '2026-11-18')).toBe(false)
    expect(proposal.blocks.some((block) => block.date === '2026-11-25')).toBe(false)
    expect(proposal.blocks.some((block) => block.date === '2026-11-17')).toBe(true)
  })

  it('counts a shift against the deadline, so the warning appears earlier', () => {
    const id = task('Finish the document', 20 * 60, DUE_EARLY)
    const withoutShift = planner.proposeRange(MONDAY, END)
    expect(withoutShift.shortfalls).toHaveLength(0)

    // Three days of the week disappear into shifts.
    for (const weekday of [1, 2, 3]) {
      store.commitments.create({
        title: 'Jumbo shift',
        weekday,
        startMin: 9 * 60,
        endMin: 17 * 60,
        kind: 'unavailable',
        organizationId: SYSTEM_ORGANIZATIONS.jumbo,
        activeFrom: MONDAY
      })
    }

    const withShift = planner.proposeRange(MONDAY, END)
    expect(withShift.shortfalls.some((entry) => entry.taskId === id)).toBe(true)
  })

  it('stops blocking time once the shift has ended', () => {
    store.commitments.create({
      title: 'Old Saturday job',
      weekday: 1,
      startMin: 9 * 60,
      endMin: 17 * 60,
      kind: 'unavailable',
      activeFrom: '2026-01-01',
      // Ended before this fortnight starts.
      activeTo: '2026-11-01'
    })

    task('Internship work', 4 * 60, DUE_LATE)
    const proposal = planner.proposeRange(MONDAY, END)

    expect(proposal.blocks.some((block) => block.date === MONDAY)).toBe(true)
  })
})

describe('what it leaves alone', () => {
  it('does not touch a day that is already planned and accepted', () => {
    const id = task('Already planned', 2 * 60, DUE_LATE)
    const draft = store.plans.createDraft({ scope: 'day', periodKey: MONDAY })
    store.plans.addBlock(draft.id, {
      taskId: id,
      date: MONDAY,
      startMin: 9 * 60,
      endMin: 11 * 60,
      locked: true
    })
    store.plans.accept(draft.id)

    const proposal = planner.proposeRange(MONDAY, END)

    // The accepted block is kept, and nothing new is placed on top of it.
    expect(proposal.kept.some((block) => block.taskId === id)).toBe(true)
    const monday = proposal.blocks.filter((block) => block.date === MONDAY)
    expect(monday.every((block) => block.startMin >= 11 * 60)).toBe(true)
  })

  it('leaves the weekend alone when no availability says otherwise', () => {
    task('Plenty to do', 40 * 60, DUE_LATE)
    const proposal = planner.proposeRange(MONDAY, END)

    // The 21st and 22nd are Saturday and Sunday.
    expect(proposal.blocks.some((block) => block.date === '2026-11-21')).toBe(false)
    expect(proposal.blocks.some((block) => block.date === '2026-11-22')).toBe(false)
  })
})

/**
 * Blocks in a row, and the one real break.
 *
 * The planner used to wedge fifteen minutes behind every focus block, which turned a day
 * into a zigzag of work and dead air that nobody asked for. The rest a day needs is lunch,
 * and lunch is a standing commitment — a wall like any other. So work that follows work
 * simply follows it.
 */
describe('blocks in a row', () => {
  const breaksOf = (proposal: { blocks: Array<{ kind?: string }> }) =>
    proposal.blocks.filter((block) => block.kind === 'break')

  it('invents no rests of its own between focus blocks', () => {
    task('Long stretch', 6 * 60, DUE_LATE)

    const proposal = planner.proposeRange(MONDAY, END)

    expect(breaksOf(proposal)).toHaveLength(0)
  })

  it('lets two focus blocks touch end to end', () => {
    task('Long stretch', 6 * 60, DUE_LATE)

    const proposal = planner.proposeRange(MONDAY, END)

    const monday = proposal.blocks
      .filter((block) => block.date === MONDAY)
      .sort((a, b) => a.startMin - b.startMin)

    expect(monday.length).toBeGreaterThan(1)
    expect(monday[1]!.startMin).toBe(monday[0]!.endMin)
  })

  it('plans around a standing break rather than through it', () => {
    store.commitments.create({
      title: 'Pauze',
      weekday: 1,
      startMin: 750,
      endMin: 780,
      kind: 'break',
      activeFrom: MONDAY
    })
    task('Long stretch', 6 * 60, DUE_LATE)

    const proposal = planner.proposeRange(MONDAY, END)

    for (const block of proposal.blocks.filter((b) => b.date === MONDAY)) {
      expect(block.startMin < 780 && block.endMin > 750).toBe(false)
    }
  })

  it('counts every planned minute as work, because all of it is', () => {
    const id = task('Long stretch', 6 * 60, DUE_LATE)

    const proposal = planner.proposeRange(MONDAY, END)

    expect(proposal.plannedMin).toBe(minutesFor(proposal, id))
    expect(proposal.plannedMin).toBe(6 * 60)
  })
})

/**
 * Chains across a range.
 *
 * A day plan cannot schedule a prerequisite and its dependant together — finishing one and
 * starting the other inside eight hours is not something it can promise — so the day planner
 * drops the dependant. Applying that rule to a fortnight made the range planner useless for
 * exactly the work it was built for: a thesis of eight chained chapters has one schedulable
 * task at any moment, so "plan the next two weeks" produced three hours of work and thirteen
 * empty days, while the planner knew perfectly well when chapter six would be finished.
 */
describe('work that has to happen in order', () => {
  const chain = (): { first: string; second: string } => {
    const first = task('Hoofdstuk 6 afmaken', 3 * 60, DUE_LATE)
    const second = task('Afmaken hoofdstuk 7', 3 * 60, DUE_LATE)
    store.dependencies.add(second, first, 'hard')
    return { first, second }
  }

  /** The last minute of a task's work, as a sortable "day then minute" pair. */
  const endOf = (
    proposal: { blocks: Array<{ taskId?: string | null; date: string; endMin: number }> },
    id: string
  ): { date: string; endMin: number } | null =>
    proposal.blocks
      .filter((block) => block.taskId === id)
      .reduce<{ date: string; endMin: number } | null>(
        (last, block) =>
          !last || block.date > last.date || (block.date === last.date && block.endMin > last.endMin)
            ? { date: block.date, endMin: block.endMin }
            : last,
        null
      )

  const startOf = (
    proposal: { blocks: Array<{ taskId?: string | null; date: string; startMin: number }> },
    id: string
  ): { date: string; startMin: number } | null =>
    proposal.blocks
      .filter((block) => block.taskId === id)
      .reduce<{ date: string; startMin: number } | null>(
        (first, block) =>
          !first ||
          block.date < first.date ||
          (block.date === first.date && block.startMin < first.startMin)
            ? { date: block.date, startMin: block.startMin }
            : first,
        null
      )

  it('schedules both links, not just the one that is startable today', () => {
    const { first, second } = chain()

    const proposal = planner.proposeRange(MONDAY, END)

    expect(minutesFor(proposal, first)).toBe(3 * 60)
    expect(minutesFor(proposal, second)).toBe(3 * 60)
  })

  it('never starts the dependant before its prerequisite has finished', () => {
    const { first, second } = chain()

    const proposal = planner.proposeRange(MONDAY, END)

    const prerequisiteEnds = endOf(proposal, first)!
    const dependantStarts = startOf(proposal, second)!
    const after =
      dependantStarts.date > prerequisiteEnds.date ||
      (dependantStarts.date === prerequisiteEnds.date &&
        dependantStarts.startMin >= prerequisiteEnds.endMin)

    expect(after).toBe(true)
  })

  it('handles a chain of three, in order', () => {
    const one = task('Chapter six', 2 * 60, DUE_LATE)
    const two = task('Chapter seven', 2 * 60, DUE_LATE)
    const three = task('Conclusion', 2 * 60, DUE_LATE)
    store.dependencies.add(two, one, 'hard')
    store.dependencies.add(three, two, 'hard')

    const proposal = planner.proposeRange(MONDAY, END)

    const ends = [endOf(proposal, one)!, endOf(proposal, two)!]
    const starts = [startOf(proposal, two)!, startOf(proposal, three)!]
    for (let index = 0; index < 2; index++) {
      const start = starts[index]!
      const end = ends[index]!
      expect(
        start.date > end.date || (start.date === end.date && start.startMin >= end.endMin)
      ).toBe(true)
    }
  })

  it('leaves the time in front of a deferred task free for other work', () => {
    const { second } = chain()
    // Due first, depends on nothing: it should still get the morning the chain cannot use.
    const errand = task('Doorlezen', 60, DUE_EARLY)

    const proposal = planner.proposeRange(MONDAY, END)

    // The gap ahead of the dependant is split rather than swallowed, so this still fits —
    // and being due soonest, it lands before the chain's later half.
    expect(minutesFor(proposal, errand)).toBe(60)
    const errandStart = startOf(proposal, errand)!
    const dependantStart = startOf(proposal, second)!
    expect(
      errandStart.date < dependantStart.date ||
        (errandStart.date === dependantStart.date && errandStart.startMin < dependantStart.startMin)
    ).toBe(true)
  })

  it('still refuses a task waiting on something genuinely stuck', () => {
    const stuck = task('Waiting on the supervisor', 2 * 60, DUE_LATE)
    store.tasks.update(stuck, { status: 'blocked', blockedReason: 'no reply' })
    const dependant = task('Cannot start', 2 * 60, DUE_LATE)
    store.dependencies.add(dependant, stuck, 'hard')

    const proposal = planner.proposeRange(MONDAY, END)

    // A blocked prerequisite is not an ordering problem, it is a dead end.
    expect(minutesFor(proposal, dependant)).toBe(0)
    expect(
      proposal.excluded.some(
        (entry) => entry.task.id === dependant && entry.reason === 'waiting-on-dependency'
      )
    ).toBe(true)
  })

  it('leaves the single-day planner refusing blocked work, as before', () => {
    const { second } = chain()

    const day = planner.proposeDay(MONDAY)

    // One day cannot promise to finish the prerequisite and start this in the same hours.
    expect(day.blocks.some((block) => block.taskId === second)).toBe(false)
    expect(
      day.excluded.some(
        (entry) => entry.task.id === second && entry.reason === 'waiting-on-dependency'
      )
    ).toBe(true)
  })
})

/**
 * Accepting a range plan.
 *
 * These are the tests the write path never had, which is how it shipped stopping at drafts:
 * `proposeRange` was covered thoroughly, and the thing that actually put a plan in your week
 * was covered not at all.
 */
describe('accepting the proposal', () => {
  const allDays = (): string[] => [
    '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20',
    '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25',
    '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29'
  ]

  /** What the week grid reads. Anything invisible here is invisible in the app. */
  const acceptedBlocks = (from: string, to: string) =>
    store.plans.acceptedBlocksForDays(allDays().filter((date) => date >= from && date <= to))

  it('writes nothing at all when only proposing', () => {
    task('Finish the document', 6 * 60, DUE_EARLY)
    planner.proposeRange(MONDAY, END)

    expect(acceptedBlocks(MONDAY, END)).toHaveLength(0)
  })

  it('puts the plan where the week grid can see it', () => {
    const id = task('Finish the document', 6 * 60, DUE_EARLY)
    const proposal = planner.applyRange(MONDAY, END)

    expect(proposal.blocks.length).toBeGreaterThan(0)
    const accepted = acceptedBlocks(MONDAY, END)
    expect(accepted.length).toBe(proposal.blocks.length)
    expect(accepted.some((block) => block.taskId === id)).toBe(true)
  })

  it('leaves no day sitting in draft', () => {
    task('Finish the document', 6 * 60, DUE_EARLY)
    const proposal = planner.applyRange(MONDAY, END)

    for (const date of new Set(proposal.blocks.map((block) => block.date))) {
      expect(store.plans.accepted('day', date)).not.toBeNull()
      expect(store.plans.draft('day', date)).toBeNull()
    }
  })

  it('counts toward the planned minutes the report and the stat card read', () => {
    const id = task('Finish the document', 6 * 60, DUE_EARLY)
    planner.applyRange(MONDAY, END)

    const days = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20']
    expect(store.plans.plannedMinutesForDays(days).get(id)).toBe(6 * 60)
  })

  it('replans without piling a second copy on top of the first', () => {
    const id = task('Finish the document', 6 * 60, DUE_EARLY)

    planner.applyRange(MONDAY, END)
    const first = acceptedBlocks(MONDAY, END).length

    planner.applyRange(MONDAY, END)

    expect(acceptedBlocks(MONDAY, END).length).toBe(first)
    // The real question behind the count: six hours of work stays six hours of work.
    expect(store.plans.plannedMinutesForDays(allDays()).get(id)).toBe(6 * 60)
  })

  it('does not plan the same task twice by scheduling around its own last run', () => {
    const id = task('Finish the document', 6 * 60, DUE_EARLY)

    planner.applyRange(MONDAY, END)
    const firstDates = new Set(
      acceptedBlocks(MONDAY, END)
        .filter((block) => block.taskId === id)
        .map((block) => block.date)
    )

    planner.applyRange(MONDAY, END)

    // Replanning an unchanged week must reproduce the same plan, not shuffle it a day later
    // and leave the original standing.
    const secondDates = new Set(
      acceptedBlocks(MONDAY, END)
        .filter((block) => block.taskId === id)
        .map((block) => block.date)
    )
    expect([...secondDates].sort()).toEqual([...firstDates].sort())
  })

  it('clears a day the replan no longer wants work on', () => {
    const id = task('Finish the document', 6 * 60, DUE_EARLY)
    planner.applyRange(MONDAY, END)
    expect(acceptedBlocks(MONDAY, END).length).toBeGreaterThan(0)

    // Finished: the next plan wants nothing, and the old blocks must not survive it.
    store.tasks.complete(id, true)
    planner.applyRange(MONDAY, END)

    expect(acceptedBlocks(MONDAY, END)).toHaveLength(0)
  })

  it('leaves a block you placed by hand alone across a replan', () => {
    const id = task('Already planned', 2 * 60, DUE_LATE)
    const draft = store.plans.createDraft({ scope: 'day', periodKey: MONDAY })
    store.plans.addBlock(draft.id, {
      taskId: id,
      date: MONDAY,
      startMin: 9 * 60,
      endMin: 11 * 60,
      source: 'manual'
    })
    store.plans.accept(draft.id)

    planner.applyRange(MONDAY, END)
    planner.applyRange(MONDAY, END)

    const mine = acceptedBlocks(MONDAY, MONDAY).filter((block) => block.source === 'manual')
    expect(mine).toHaveLength(1)
    expect(mine[0]!.startMin).toBe(9 * 60)
  })

  it('reports nothing pending once a range has been accepted', () => {
    task('Finish the document', 6 * 60, DUE_EARLY)
    planner.applyRange(MONDAY, END)

    expect(store.plans.pendingDrafts()).toHaveLength(0)
  })

  it('keeps a block you locked by hand and plans around it', () => {
    const id = task('Already planned', 2 * 60, DUE_LATE)
    const draft = store.plans.createDraft({ scope: 'day', periodKey: MONDAY })
    store.plans.addBlock(draft.id, {
      taskId: id,
      date: MONDAY,
      startMin: 9 * 60,
      endMin: 11 * 60,
      locked: true
    })
    store.plans.accept(draft.id)

    planner.applyRange(MONDAY, END)

    const monday = acceptedBlocks(MONDAY, MONDAY)
    const locked = monday.find((block) => block.taskId === id && block.locked)
    expect(locked).toBeDefined()
    expect(locked!.startMin).toBe(9 * 60)
  })
})

/**
 * The internship window inside the working day.
 *
 * The working hours say when you are willing to work at all. In a busy fortnight that is
 * nine in the morning to ten at night, and the planner used to read those thirteen hours as
 * thirteen hours of everything. They are not: the internship runs nine to six, and the
 * evening belongs to school and to personal work. Both halves of that are enforced — an
 * internship block at half past eight in the evening is hours nobody worked, and a personal
 * errand at eleven in the morning is internship time spent on something else.
 */
describe('the internship window', () => {
  /** A long day: willing to work until ten, internship until six. */
  const longDays = (): void => {
    for (let weekday = 1; weekday <= 5; weekday++) {
      store.availability.upsert({
        week: null,
        weekday,
        startMin: 9 * 60,
        endMin: 22 * 60,
        allowedAreas: [],
        areaTargets: {},
        enabled: true,
        stageStartMin: 9 * 60,
        stageEndMin: 18 * 60
      })
    }
  }

  const other = (title: string, estimateMin: number, dueDate?: string): string =>
    store.tasks.create({
      title,
      areaId: SYSTEM_AREAS.personal,
      estimateMin,
      ...(dueDate ? { dueDate } : {})
    }).id

  it('keeps internship work inside the internship hours', () => {
    longDays()
    task('Field report', 10 * 60, DUE_LATE)

    const proposal = planner.proposeRange(MONDAY, END)

    expect(proposal.blocks.length).toBeGreaterThan(0)
    for (const block of proposal.blocks) {
      expect(block.startMin).toBeGreaterThanOrEqual(9 * 60)
      expect(block.endMin).toBeLessThanOrEqual(18 * 60)
    }
  })

  it('keeps everything else out of them', () => {
    longDays()
    const id = other('School assignment', 4 * 60, DUE_LATE)

    const proposal = planner.proposeRange(MONDAY, END)
    const mine = proposal.blocks.filter((block) => block.taskId === id)

    expect(mine.length).toBeGreaterThan(0)
    for (const block of mine) {
      expect(block.startMin).toBeGreaterThanOrEqual(18 * 60)
    }
  })

  it('does not let the evening count as capacity for an internship deadline', () => {
    longDays()
    // Nine to six is nine hours a day, minus the buffer. Forty hours before Wednesday needs
    // the evenings to fit, and the evenings are not the internship's to take.
    task('Impossible by Wednesday', 40 * 60, '2026-11-18')

    const proposal = planner.proposeRange(MONDAY, END)

    expect(proposal.shortfalls.length).toBe(1)
    expect(proposal.shortfalls[0]!.shortfallMin).toBeGreaterThan(0)
  })

  it('places no internship work on a day that has no internship hours', () => {
    longDays()
    store.availability.upsert({
      week: null,
      weekday: 6,
      startMin: 10 * 60,
      endMin: 18 * 60,
      allowedAreas: [],
      areaTargets: {},
      enabled: true,
      stageStartMin: null,
      stageEndMin: null
    })
    task('Field report', 30 * 60, DUE_LATE)

    const proposal = planner.proposeRange(MONDAY, END)

    // 2026-11-21 is the Saturday of that week.
    expect(proposal.blocks.some((block) => block.date === '2026-11-21')).toBe(false)
  })
})

/**
 * The weekend is capacity of last resort.
 *
 * A Saturday that is open for personal work is not an invitation to fill it. Work that fits
 * in the working week goes in the working week; the weekend is reached for when a deadline
 * genuinely needs it, and then it is used without complaint.
 */
describe('weekends', () => {
  const openWeekend = (): void => {
    for (const weekday of [6, 7]) {
      store.availability.upsert({
        week: null,
        weekday,
        startMin: 10 * 60,
        endMin: 18 * 60,
        allowedAreas: [],
        areaTargets: {},
        enabled: true,
        stageStartMin: null,
        stageEndMin: null
      })
    }
  }

  const personal = (title: string, estimateMin: number, dueDate?: string): string =>
    store.tasks.create({
      title,
      areaId: SYSTEM_AREAS.personal,
      estimateMin,
      ...(dueDate ? { dueDate } : {})
    }).id

  it('uses the weekend when the working week has no room for that kind of work', () => {
    openWeekend()
    // The weekday window here is nine to five and entirely internship hours, so personal
    // work has nowhere to go during the week. The weekend is last resort, not never.
    personal('Errands', 2 * 60, DUE_LATE)

    const proposal = planner.proposeRange(MONDAY, END)
    const weekendDays = proposal.blocks.filter(
      (block) => block.date === '2026-11-21' || block.date === '2026-11-22'
    )

    expect(weekendDays.length).toBeGreaterThan(0)
  })

  it('prefers a weekday evening over a Saturday for the same work', () => {
    openWeekend()
    for (let weekday = 1; weekday <= 5; weekday++) {
      store.availability.upsert({
        week: null,
        weekday,
        startMin: 9 * 60,
        endMin: 22 * 60,
        allowedAreas: [],
        areaTargets: {},
        enabled: true,
        stageStartMin: 9 * 60,
        stageEndMin: 18 * 60
      })
    }
    personal('Errands', 2 * 60, DUE_LATE)

    const proposal = planner.proposeRange(MONDAY, END)

    expect(proposal.blocks.every((block) => block.date < '2026-11-21')).toBe(true)
  })
})
