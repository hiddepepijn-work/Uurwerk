/**
 * The planner, assembled.
 *
 * Reads the world, ranks what may be scheduled, fills the gaps, and hands back a proposal.
 * Everything that computes — `proposeDay`, `replanRestOfDay`, `proposeRange` — writes
 * nothing at all, so a proposal can always be shown before it means anything.
 *
 * `applyRange` is the one exception, and it is deliberately the only one: it exists to be
 * called *after* the user has agreed to a proposal they could read in full. Nothing else
 * here can change what you already agreed to.
 */

import type {
  IsoDate,
  IsoWeek,
  PlanBlock,
  PlanIntensity,
  PlanningProfile,
  Task
} from '../../contract/types.js'
import type { Store } from '../../db/index.js'
import { fromIsoDate, toIsoDate, addDays, isoWeekday, toIsoWeek, weekRange } from '../../util/time.js'
import { buildDayWindow, type DayWindow } from './availability.js'
import { filterCandidates, type Excluded } from './candidate-filter.js'
import { DependencyGraph } from './dependency-graph.js'
import { buildDaySchedule, type ScheduledBlock } from './schedule-builder.js'
import { scoreCandidates, type ScoredTask } from './priority-score.js'
import { isReplaceable, planRange, type RangeProposal } from './range.js'
import { splitForReplan } from './replan.js'

export interface DayProposal {
  date: IsoDate
  blocks: ScheduledBlock[]
  /** Blocks that were kept exactly as they were: past, running, locked or fixed. */
  kept: PlanBlock[]
  unplaced: Array<{ taskId: string; taskTitle: string; reason: string; minutes: number }>
  excluded: Excluded[]
  ranked: ScoredTask[]
  plannedMin: number
  bufferMin: number
  availableMin: number
}

export interface ProposeOptions {
  /** Leave the morning alone and only fill from `nowMin` onward. */
  fromMin?: number
  activeBlockId?: string | null
  intensity?: PlanIntensity
  /** Working window for a day that has none set. */
  fallbackHours?: { startMin: number; endMin: number }
}

export class PlannerService {
  constructor(private readonly store: Store) {}

  profile(): PlanningProfile {
    return this.store.availability.defaultProfile()
  }

  /**
   * Builds a proposal for one day.
   *
   * Deadline pressure is measured against the working time in the whole week, not against
   * calendar days — "due Friday" means something different when Thursday is already full.
   */
  proposeDay(date: IsoDate, options: ProposeOptions = {}): DayProposal {
    const profile = this.profile()
    const intensity = options.intensity ?? 'balanced'

    const existing = this.blocksFor(date)
    const { keep } = splitForReplan({
      blocks: existing,
      nowMin: options.fromMin ?? 0,
      activeBlockId: options.activeBlockId ?? null
    })

    const window = buildDayWindow({
      date,
      availability: this.availabilityFor(date),
      events: this.wallsOn(date),
      existing: keep,
      intensity,
      notBeforeMin: options.fromMin,
      fallback: options.fallbackHours
    })

    const tasks = this.store.tasks.list()
    const graph = new DependencyGraph(tasks, this.store.dependencies.all())
    const { candidates, excluded } = filterCandidates({ tasks, graph, profile, date })

    const windows = this.weekWindows(toIsoWeek(fromIsoDate(date)), intensity)
    const largestGapMin = window.gaps.reduce((max, gap) => Math.max(max, gap.minutes), 0)

    const ranked = scoreCandidates({
      candidates,
      windows,
      profile,
      date,
      recentProjectId: this.recentProjectId(date),
      largestGapMin
    })

    const schedule = buildDaySchedule({
      window,
      scored: ranked,
      profile,
      date,
      keep,
      stageAreaIds: this.stageAreaIds()
    })

    return {
      date,
      blocks: schedule.blocks,
      kept: keep,
      unplaced: schedule.unplaced,
      excluded,
      ranked,
      plannedMin: schedule.plannedMin,
      bufferMin: schedule.bufferMin,
      availableMin: window.fillableMin
    }
  }

  /** The same, but leaving everything before `nowMin` untouched. */
  replanRestOfDay(date: IsoDate, nowMin: number, activeBlockId?: string | null): DayProposal {
    return this.proposeDay(date, { fromMin: nowMin, activeBlockId })
  }

  // ------------------------------------------------------------- internals

  private blocksFor(date: IsoDate): PlanBlock[] {
    const plan = this.store.plans.accepted('day', date)
    return plan ? this.store.plans.blocks(plan.id) : []
  }

  private availabilityFor(date: IsoDate) {
    const week = toIsoWeek(fromIsoDate(date))
    return this.store.availability.forWeek(week).find((row) => row.weekday === isoWeekday(date)) ?? null
  }

  /**
   * The areas whose hours count toward the internship.
   *
   * Read from the areas the user configured rather than hard-coded to the built-in Stage
   * id: a second internship, or a renamed one, has to obey the same window.
   */
  private stageAreaIds(): ReadonlySet<string> {
    return new Set(
      this.store.areas
        .list(true)
        .filter((area) => area.countsAsStageHours)
        .map((area) => area.id)
    )
  }

  /**
   * Everything in the way on a date: one-off events and the standing weekly commitments.
   *
   * A shift is a wall like any other as far as the scheduler is concerned, so the two are
   * merged here rather than teaching every caller about both.
   */
  private wallsOn(date: IsoDate) {
    return [
      ...this.store.availability.eventsOn(date),
      ...this.store.commitments.occurrencesOn(date)
    ]
  }

  /**
   * Plans a stretch of days at once, deadline first.
   *
   * This is what can answer "will it be done by the 23rd": the day planner only ever sees
   * one day, so it has no way to notice that the hours before a deadline have run out.
   */
  proposeRange(from: IsoDate, to: IsoDate, options: ProposeOptions = {}): RangeProposal {
    const days = this.daysBetween(from, to)

    return planRange({
      days: days.map((date) => ({
        date,
        availability: this.availabilityFor(date),
        events: this.wallsOn(date),
        // What you placed by hand, locked or fixed is respected and planned around. The
        // planner's *own* earlier blocks are not: `applyRange` replaces exactly those, so
        // treating them as occupied would make a replan schedule around itself and plan the
        // same work a second time on the next free day.
        existing: this.blocksFor(date).filter((block) => !isReplaceable(block))
      })),
      tasks: this.store.tasks.list(),
      edges: this.store.dependencies.all(),
      profile: this.profile(),
      intensity: options.intensity ?? 'balanced',
      stageAreaIds: this.stageAreaIds(),
      ...(options.fromMin !== undefined ? { fromMinOnFirstDay: options.fromMin } : {}),
      recentProjectId: this.recentProjectId(days[0] ?? from)
    })
  }

  /**
   * The same proposal, written into each day it touches and accepted there.
   *
   * The one method in this file that writes, and it is separate from `proposeRange` for
   * exactly that reason: the caller shows the proposal, the user agrees to it, and only then
   * does this run. What it must not do is stop at drafts. Every reader of a week — the grid,
   * the planned total, planned-versus-actual, the report — takes the *accepted* plan of each
   * day, so a fortnight left in draft is a fortnight of empty days, and the user who pressed
   * Accept watches nothing happen.
   *
   * One transaction for the whole stretch: the days are only useful as a set, and a
   * half-written fortnight is worse than none.
   */
  applyRange(from: IsoDate, to: IsoDate, options: ProposeOptions = {}): RangeProposal {
    const proposal = this.proposeRange(from, to, options)

    this.store.db.transaction(() => {
      const byDate = new Map<IsoDate, typeof proposal.blocks>()
      for (const block of proposal.blocks) {
        const bucket = byDate.get(block.date)
        if (bucket) bucket.push(block)
        else byDate.set(block.date, [block])
      }

      // Every day in the range, not only the ones the new proposal happens to fill. A day
      // the replan no longer wants work on has to be cleared of the last run's blocks, or
      // they survive as a plan nothing intends any more.
      for (const date of this.daysBetween(from, to)) {
        const blocks = byDate.get(date) ?? []
        const inForce = this.store.plans.accepted('day', date)
        const stale = inForce
          ? this.store.plans.blocks(inForce.id).some((block) => isReplaceable(block))
          : false

        // Nothing to add and nothing of ours to remove: leave the day completely alone
        // rather than stamping an empty plan onto it.
        if (blocks.length === 0 && !stale) continue

        let draft = this.store.plans.draft('day', date)

        if (!draft) {
          draft = this.store.plans.createDraft({
            scope: 'day',
            periodKey: date,
            reason: `Planned as part of ${proposal.from} – ${proposal.to}`
          })

          // A new draft starts empty, so it has to be seeded from the plan in force before
          // it can replace it. Without this the accept below supersedes the accepted day
          // and takes everything you placed by hand down with it — and `proposeRange` has
          // already planned *around* those blocks, so their time would be double-booked.
          const accepted = this.store.plans.accepted('day', date)
          if (accepted) this.store.plans.copyBlocks(accepted.id, draft.id)
        }

        // A draft reopened from a previous run keeps anything you placed by hand; only the
        // planner's own blocks are replaced — the same set `proposeRange` treated as free.
        for (const existing of this.store.plans.blocks(draft.id)) {
          if (isReplaceable(existing)) this.store.plans.removeBlock(existing.id)
        }
        for (const block of blocks) this.store.plans.addBlock(draft.id, block)

        this.store.plans.accept(draft.id)
      }
    })

    return proposal
  }

  /** Every date from `from` to `to`, inclusive. Proposing and applying must walk the same list. */
  private daysBetween(from: IsoDate, to: IsoDate): IsoDate[] {
    const days: IsoDate[] = []
    for (
      let cursor = fromIsoDate(from).getTime();
      cursor <= fromIsoDate(to).getTime();
      cursor = addDays(cursor, 1).getTime()
    ) {
      days.push(toIsoDate(cursor))
    }
    return days
  }

  /** Windows for every day of a week — what deadline slack is measured against. */
  private weekWindows(week: IsoWeek, intensity: PlanIntensity): DayWindow[] {
    const { days } = weekRange(week)
    const today = toIsoDate(Date.now())

    return days
      // Days already gone cannot absorb work, so they must not count toward slack.
      .filter((date) => date >= today)
      .map((date) =>
        buildDayWindow({
          date,
          availability: this.availabilityFor(date),
          events: this.wallsOn(date),
          existing: this.blocksFor(date),
          intensity
        })
      )
  }

  /** The project of the most recent tracked segment, for the context-switch bonus. */
  private recentProjectId(date: IsoDate): string | null {
    const start = fromIsoDate(date).getTime()
    const segments = this.store.tracking.segmentsInRange(
      addDays(start, -1).getTime(),
      addDays(start, 1).getTime()
    )
    const last = segments[segments.length - 1]
    if (!last?.taskId) return null
    return this.store.tasks.get(last.taskId)?.projectId ?? null
  }
}

export type { RangeProposal, Shortfall, ScheduledRangeBlock } from './range.js'
export { planRange } from './range.js'
export type { ScheduledBlock } from './schedule-builder.js'
export type { ScoredTask } from './priority-score.js'
export type { Excluded } from './candidate-filter.js'
export { DependencyGraph } from './dependency-graph.js'
export { diffPlans, affectedDays, isUnchanged } from './plan-diff.js'
export { splitForReplan, minutesBehind } from './replan.js'
export { explain, reasons, headline } from './explain-score.js'
export { remainingEffort, splitIntoBlocks, needsTime } from './remaining-effort.js'
export { buildDayWindow, workingMinutesUntil } from './availability.js'
export { filterCandidates } from './candidate-filter.js'
export { scoreCandidates, WEIGHTS } from './priority-score.js'
export { buildDaySchedule } from './schedule-builder.js'
export type { Task }
