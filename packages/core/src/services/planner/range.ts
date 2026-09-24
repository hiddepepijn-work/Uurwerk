/**
 * Planning a stretch of days rather than one day.
 *
 * The day planner answers "what should I do today". It cannot answer "will the document be
 * finished by the 23rd", because that question is about capacity between now and then — and
 * capacity is made of days, most of which already have shifts, classes and meetings in them.
 *
 * The order here is the whole design, and it is deadline-first rather than score-first:
 *
 *   1. days are walked in order, each with its own window, its walls and whatever is
 *      already locked into it
 *   2. tasks are taken in deadline order, earliest first, so the thing due on the 23rd gets
 *      the hours before the 23rd — the task due on the 28th cannot eat them first
 *   3. work is never placed after its own due date. If it does not fit, that is a fact
 *      about the week, and inventing a block on the 25th for something due on the 23rd
 *      would hide exactly the problem you needed to see
 *   4. what is left over — no deadline, or beyond the horizon — fills the remaining gaps by
 *      score, the same ranking the day planner uses
 *
 * Two things are decided before any of that, because they are constraints rather than
 * preferences. Internship work only ever lands inside the internship window of a day, and
 * everything else only outside it — a fortnight entered as nine in the morning to ten at
 * night is not thirteen internship hours a day, it is nine to six of internship with the
 * evening left for school and personal work. And the weekend is filled last: it is real
 * capacity and a deadline may need it, but an ordinary fortnight should not quietly eat
 * your Saturdays.
 *
 * When something cannot fit, the answer is not a smaller plan. It is a shortfall: how many
 * hours are missing, the earliest date the work could actually be done by, and how much
 * would have to be freed per day to keep the original date. Those are the two real options —
 * find more hours, or move the deadline — and the caller offers them rather than choosing.
 */

import type {
  Availability,
  FixedEvent,
  IsoDate,
  NewPlanBlock,
  PlanBlock,
  PlanIntensity,
  PlanningProfile,
  Shortfall,
  Task
} from '../../contract/types.js'
import { buildDayWindow, type DayWindow, type Gap } from './availability.js'
import { filterCandidates, type Excluded } from './candidate-filter.js'
import { DependencyGraph } from './dependency-graph.js'
import { explain } from './explain-score.js'
import { splitIntoBlocks } from './remaining-effort.js'
import { scoreCandidates, type ScoredTask } from './priority-score.js'

export interface RangeDayInput {
  date: IsoDate
  availability: Availability | null
  events: FixedEvent[]
  /** Blocks already in the accepted plan for that day, which are kept where they are. */
  existing: PlanBlock[]
}

export interface RangePlanInput {
  days: RangeDayInput[]
  tasks: Task[]
  edges: ConstructorParameters<typeof DependencyGraph>[1]
  profile: PlanningProfile
  intensity: PlanIntensity
  /**
   * Areas whose hours count toward the internship.
   *
   * Passed in rather than looked up, because this file is pure and because the set is a
   * property of the areas the user configured, not something derivable from a task.
   */
  stageAreaIds: ReadonlySet<string>
  /** Nothing is placed before this minute on the first day — the morning is already gone. */
  fromMinOnFirstDay?: number
  recentProjectId?: string | null
}

export interface ScheduledRangeBlock extends NewPlanBlock {
  score: number
  explanation: string
}

// Declared in the contract, because the warning is rendered: `earliestFinishDate` is null
// when the work does not fit inside the range at all, and the honest answer then is "not
// from here" rather than a date invented beyond the horizon.
export type { Shortfall }

export interface RangeProposal {
  from: IsoDate
  to: IsoDate
  blocks: ScheduledRangeBlock[]
  kept: PlanBlock[]
  shortfalls: Shortfall[]
  /** Tasks with no deadline that did not fit. Not a problem, just not this fortnight. */
  unplaced: Array<{ taskId: string; taskTitle: string; minutes: number; reason: string }>
  excluded: Excluded[]
  ranked: ScoredTask[]
  plannedMin: number
  availableMin: number
}

/**
 * Blocks a replan is free to move: the planner's own, neither locked nor fixed.
 *
 * One predicate, deliberately shared by the two halves of a replan. `proposeRange` must
 * treat exactly the blocks that `applyRange` is going to delete as free time, or the two
 * disagree — and the way they disagreed was silent duplication: the proposal planned around
 * its own previous placement, put the same six hours on the next day, and the apply step
 * cleared only the days the new proposal happened to mention. One task, twice, in one week.
 */
export const isReplaceable = (block: PlanBlock): boolean =>
  block.source === 'planner' && !block.locked && !block.fixed

/**
 * There is no rest inserted between two focus blocks.
 *
 * The planner used to wedge fifteen minutes behind every block, which turned a plan into a
 * zigzag of work and dead air. The day already has its one real break — lunch, a standing
 * commitment, and therefore a wall the planner schedules around like any other. Blocks that
 * follow each other simply follow each other.
 */

/** A moment inside the range: which day, and how far into it. */
interface Position {
  date: IsoDate
  minute: number
}

/** Later of two positions, treating "nothing yet" as the earliest possible moment. */
const latest = (a: Position | null, b: Position): Position => {
  if (!a) return b
  if (a.date !== b.date) return a.date > b.date ? a : b
  return a.minute >= b.minute ? a : b
}

/** Free time across the whole range, consumed as blocks are placed. */
class Calendar {
  private readonly gaps: Array<Gap & { date: IsoDate }> = []

  constructor(windows: DayWindow[]) {
    for (const window of windows) {
      for (const gap of window.gaps) this.gaps.push({ ...gap, date: window.date })
    }
    this.gaps.sort((a, b) => (a.date === b.date ? a.startMin - b.startMin : a.date < b.date ? -1 : 1))
  }

  /**
   * Minutes free on or before a date — the number a deadline is actually judged against.
   *
   * Filtered by side of the internship boundary when one is given, because that is the only
   * capacity the task in question can use. Counting the evenings toward an internship
   * deadline would report a comfortable week and then fail to place the work.
   */
  freeUntil(date: IsoDate, stage?: boolean): number {
    return this.gaps
      .filter((gap) => gap.date <= date && (stage === undefined || gap.stage === stage))
      .reduce((sum, gap) => sum + gap.minutes, 0)
  }

  freeTotal(stage?: boolean): number {
    return this.gaps
      .filter((gap) => stage === undefined || gap.stage === stage)
      .reduce((sum, gap) => sum + gap.minutes, 0)
  }

  /**
   * Takes the earliest slot that fits, no later than `notAfter` and no earlier than `after`.
   *
   * Earliest-first is what makes a deadline mean something: work due sooner is placed
   * sooner, and the day fills forward rather than leaving holes for later arrivals.
   *
   * `stage` is matched exactly. Internship work goes in internship hours and nothing else
   * does — the evening of a long day is capacity for school and personal work, and for
   * those two it is the *only* capacity.
   *
   * The weekend is tried only after the working week has been exhausted, so a fortnight
   * fills Monday to Friday first and reaches for a Saturday when a deadline genuinely needs
   * one. That is why this scans twice rather than once.
   *
   * `after` is what lets a chain be scheduled in order — chapter seven goes behind chapter
   * six rather than being dropped for waiting on it. Time before that point is not consumed:
   * a gap that only partly overlaps is split, so the earlier half stays free for work that
   * has no such constraint. Losing it would make one long chain quietly sterilise the whole
   * morning in front of it.
   */
  take(
    minutes: number,
    stage: boolean,
    notAfter?: IsoDate,
    after?: Position
  ): { date: IsoDate; startMin: number; endMin: number } | null {
    return this.scan(minutes, stage, false, notAfter, after) ?? this.scan(minutes, stage, true, notAfter, after)
  }

  /** One pass over either the working week (reserve false) or the weekend (reserve true). */
  private scan(
    minutes: number,
    stage: boolean,
    reserve: boolean,
    notAfter?: IsoDate,
    after?: Position
  ): { date: IsoDate; startMin: number; endMin: number } | null {
    for (let index = 0; index < this.gaps.length; index++) {
      const gap = this.gaps[index]!
      if (notAfter && gap.date > notAfter) break
      if (gap.stage !== stage || gap.reserve !== reserve) continue

      const gapEnd = gap.startMin + gap.minutes
      let start = gap.startMin
      if (after) {
        if (gap.date < after.date) continue
        if (gap.date === after.date) start = Math.max(start, after.minute)
      }
      if (gapEnd - start < minutes) continue

      const slot = { date: gap.date, startMin: start, endMin: start + minutes }

      // Up to two remainders: what sat in front of the constraint, and what is left behind
      // the block. Either can be empty.
      const replacements: Array<Gap & { date: IsoDate }> = []
      if (start > gap.startMin) {
        replacements.push({ ...gap, startMin: gap.startMin, minutes: start - gap.startMin })
      }
      if (gapEnd > slot.endMin) {
        replacements.push({ ...gap, startMin: slot.endMin, minutes: gapEnd - slot.endMin })
      }
      this.gaps.splice(index, 1, ...replacements)

      return slot
    }
    return null
  }

  /**
   * The date by which `minutes` of free time have accumulated, ignoring deadlines.
   *
   * This is the "if you moved it, when could it actually be done" answer, and it is
   * computed from what is left *after* everything more urgent has already taken its share.
   */
  dateAfterAccumulating(minutes: number, stage: boolean): IsoDate | null {
    let remaining = minutes
    for (const gap of this.gaps) {
      if (gap.stage !== stage) continue
      remaining -= gap.minutes
      if (remaining <= 0) return gap.date
    }
    return null
  }
}

export function planRange(input: RangePlanInput): RangeProposal {
  const windows = input.days.map((day, index) =>
    buildDayWindow({
      date: day.date,
      availability: day.availability,
      events: day.events,
      existing: day.existing,
      intensity: input.intensity,
      /**
       * A day with no availability row is not a working day.
       *
       * The single-day planner falls back to office hours, which is right when you have
       * opened a day and asked for a plan — you are telling it that day counts. Across a
       * range nobody said that about Saturday, and assuming it would fill weekends with
       * work and, worse, count those hours as capacity when judging a deadline.
       */
      fallback: day.availability ? undefined : { startMin: 0, endMin: 0 },
      ...(index === 0 && input.fromMinOnFirstDay !== undefined
        ? { notBeforeMin: input.fromMinOnFirstDay }
        : {})
    })
  )

  const calendar = new Calendar(windows)
  const availableMin = calendar.freeTotal()

  const graph = new DependencyGraph(input.tasks, input.edges)
  const { candidates, excluded } = filterCandidates({
    tasks: input.tasks,
    graph,
    profile: input.profile,
    date: input.days[0]?.date ?? '',
    // Across a range a prerequisite and its dependant can both be scheduled, in that order.
    deferBlocked: true
  })

  const ranked = scoreCandidates({
    candidates,
    windows,
    profile: input.profile,
    date: input.days[0]?.date ?? '',
    recentProjectId: input.recentProjectId ?? null,
    largestGapMin: windows.reduce(
      (max, window) => Math.max(max, ...window.gaps.map((gap) => gap.minutes), 0),
      0
    )
  })

  const blocks: ScheduledRangeBlock[] = []
  const shortfalls: Shortfall[] = []
  const unplaced: RangeProposal['unplaced'] = []
  const lastDay = input.days[input.days.length - 1]?.date ?? ''

  // Deadline first, then the ranking. A task due on the 23rd is placed before one due on
  // the 28th even if the later one scores higher — the score decides taste, the deadline
  // decides possibility.
  const byUrgency = (a: ScoredTask, b: ScoredTask): number => {
    const dueA = a.task.dueDate
    const dueB = b.task.dueDate
    if (dueA && dueB && dueA !== dueB) return dueA < dueB ? -1 : 1
    if (dueA && !dueB) return -1
    if (!dueA && dueB) return 1
    return b.score - a.score
  }

  /**
   * Where each task's work finishes, once it has been placed.
   *
   * This is what a dependant is scheduled behind. A task absent from this map has not been
   * placed yet, which is exactly the condition for its dependants not being ready.
   */
  const finishedAt = new Map<string, Position>()

  /**
   * Deadline order, but never before a prerequisite.
   *
   * A plain sort cannot express both: the most urgent task in a chain is usually the last
   * link, and placing it first is precisely the nonsense this is here to avoid. So the most
   * urgent *ready* task is taken repeatedly instead — a topological selection, with urgency
   * deciding only among tasks that are genuinely free to start.
   */
  const remaining = [...ranked].sort(byUrgency)
  /** Task ids in this run — a blocker outside it can never become ready, so it never gates. */
  const inRun = new Set(ranked.map((scored) => scored.task.id))
  /** Considered already, whether or not it found room. Readiness asks about this, not success. */
  const processed = new Set<string>()

  while (remaining.length > 0) {
    const readyIndex = remaining.findIndex((scored) =>
      graph
        .blockedBy(scored.task.id)
        .every((edge) => !inRun.has(edge.dependsOnTaskId) || processed.has(edge.dependsOnTaskId))
    )

    // Nothing ready means a cycle the write-time check let through. Falling back to the
    // urgency order keeps the planner answering rather than looping forever.
    const index = readyIndex === -1 ? 0 : readyIndex
    const scored = remaining.splice(index, 1)[0]!
    processed.add(scored.task.id)

    const due = scored.task.dueDate
    const deadline = due && due <= lastDay ? due : undefined
    const wantsStage =
      scored.task.areaId !== null && input.stageAreaIds.has(scored.task.areaId)

    // Behind every hard prerequisite that is part of this run.
    let after: Position | null = null
    for (const edge of graph.blockedBy(scored.task.id)) {
      const end = finishedAt.get(edge.dependsOnTaskId)
      if (end) after = latest(after, end)
    }

    // What the deadline is judged against: free time before it, not the whole range.
    const freeBefore = deadline
      ? calendar.freeUntil(deadline, wantsStage)
      : calendar.freeTotal(wantsStage)
    let placedMin = 0

    for (const chunk of splitIntoBlocks(scored.scheduleMin, input.profile)) {
      const size = Math.max(input.profile.minimumBlockMin, chunk)
      const slot = calendar.take(size, wantsStage, deadline, after ?? undefined)
      if (!slot) break

      blocks.push({
        taskId: scored.task.id,
        areaId: scored.task.areaId,
        date: slot.date,
        startMin: slot.startMin,
        endMin: slot.endMin,
        kind: 'task',
        source: 'planner',
        score: scored.score,
        explanation: explain(scored)
      })
      placedMin += size
      finishedAt.set(
        scored.task.id,
        latest(finishedAt.get(scored.task.id) ?? null, { date: slot.date, minute: slot.endMin })
      )
    }

    const missing = scored.scheduleMin - placedMin
    if (missing <= 0) continue

    if (deadline) {
      const daysBeforeDue = input.days.filter(
        (day) => day.date <= deadline && windowFor(windows, day.date) > 0
      ).length

      shortfalls.push({
        taskId: scored.task.id,
        taskTitle: scored.task.title,
        dueDate: deadline,
        requiredMin: scored.scheduleMin,
        availableMin: Math.min(freeBefore, scored.scheduleMin),
        shortfallMin: missing,
        // What is left in the calendar now belongs to this task first, so this is the real
        // date it could be finished by if the deadline moved.
        earliestFinishDate: calendar.dateAfterAccumulating(missing, wantsStage),
        extraMinPerDay: daysBeforeDue > 0 ? Math.ceil(missing / daysBeforeDue / 15) * 15 : missing,
        daysBeforeDue
      })
      continue
    }

    unplaced.push({
      taskId: scored.task.id,
      taskTitle: scored.task.title,
      minutes: missing,
      reason: placedMin > 0 ? 'partially placed — the rest did not fit' : 'no room in this range'
    })
  }

  const placed = blocks.sort((a, b) =>
    a.date === b.date ? a.startMin - b.startMin : a.date < b.date ? -1 : 1
  )

  return {
    from: input.days[0]?.date ?? '',
    to: lastDay,
    blocks: placed,
    kept: input.days.flatMap((day) => day.existing),
    shortfalls,
    unplaced,
    excluded,
    ranked,
    // Work, not wall-clock: a break is time the plan deliberately does not claim, and
    // counting it as planned would inflate every total that reads this.
    plannedMin: placed
      .filter((block) => block.kind === 'task')
      .reduce((sum, block) => sum + (block.endMin - block.startMin), 0),
    availableMin
  }
}

const windowFor = (windows: DayWindow[], date: IsoDate): number =>
  windows.find((window) => window.date === date)?.fillableMin ?? 0
