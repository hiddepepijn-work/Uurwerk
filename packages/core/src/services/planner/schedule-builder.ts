/**
 * Places blocks into a day.
 *
 * The order is the whole design:
 *
 *   0. internship work may only land inside the internship window, and everything else
 *      only outside it — a constraint, not a preference, so it is applied before any score
 *   1. fixed events and locked blocks are untouchable — they define the shape of the day
 *   2. at-risk work goes first, because a missed deadline is a different kind of failure
 *   3. then simply the highest-scoring work that fits
 *   4. buffer is never filled
 *
 * Unlocking downstream work is not a separate step: it is a weighted term in the score
 * (priority-score.ts), so it competes with the other reasons rather than jumping the queue.
 * At-risk work is the one thing that does jump, and it does so in the sort, not here.
 *
 * Nothing is ever placed on top of something else, and nothing is placed in the past.
 * The result is a proposal — the caller decides whether it becomes a plan.
 */

import type { IsoDate, NewPlanBlock, PlanningProfile, PlanBlock } from '../../contract/types.js'
import type { DayWindow, Gap } from './availability.js'
import type { ScoredTask } from './priority-score.js'
import { splitIntoBlocks } from './remaining-effort.js'
import { explain } from './explain-score.js'

export interface ScheduledBlock extends NewPlanBlock {
  /** Kept so the UI can show the reasoning without recomputing it. */
  score: number
  explanation: string
}

export interface SchedulingResult {
  blocks: ScheduledBlock[]
  /** Tasks that did not fit, with the reason in plain language. */
  unplaced: Array<{ taskId: string; taskTitle: string; reason: string; minutes: number }>
  /** Minutes left unfilled on purpose. */
  bufferMin: number
  plannedMin: number
}

/** Free space, consumed as blocks are placed. */
class GapList {
  constructor(private gaps: Gap[]) {
    this.gaps = [...gaps].sort((a, b) => a.startMin - b.startMin)
  }

  get largest(): number {
    return this.gaps.reduce((max, gap) => Math.max(max, gap.minutes), 0)
  }

  get free(): number {
    return this.gaps.reduce((sum, gap) => sum + gap.minutes, 0)
  }

  /** Free minutes on the side of the internship boundary a task is allowed to use. */
  freeFor(stage: boolean): number {
    return this.gaps
      .filter((gap) => gap.stage === stage)
      .reduce((sum, gap) => sum + gap.minutes, 0)
  }

  /**
   * Earliest gap that fits, so the day fills forward rather than leaving holes.
   *
   * `stage` is matched exactly rather than treated as a minimum: internship work in the
   * evening is not internship work, and school work inside internship hours is time the
   * internship is not getting back.
   */
  take(minutes: number, stage: boolean): { startMin: number; endMin: number } | null {
    for (let index = 0; index < this.gaps.length; index++) {
      const gap = this.gaps[index]!
      if (gap.stage !== stage) continue
      if (gap.minutes < minutes) continue

      const slot = { startMin: gap.startMin, endMin: gap.startMin + minutes }
      const remainder = gap.minutes - minutes

      if (remainder === 0) this.gaps.splice(index, 1)
      else this.gaps[index] = { ...gap, startMin: slot.endMin, minutes: remainder }

      return slot
    }
    return null
  }
}

export function buildDaySchedule(input: {
  window: DayWindow
  scored: ScoredTask[]
  profile: PlanningProfile
  date: IsoDate
  /** Blocks that stay exactly where they are. */
  keep: PlanBlock[]
  /** Areas whose hours count toward the internship; everything else is other work. */
  stageAreaIds: ReadonlySet<string>
}): SchedulingResult {
  const gaps = new GapList(input.window.gaps)
  const blocks: ScheduledBlock[] = []
  const unplaced: SchedulingResult['unplaced'] = []

  // Buffer is reserved up front by refusing to fill the last slice of free time, rather
  // than by placing a buffer block somewhere arbitrary.
  const budget = Math.max(0, gaps.free - input.window.bufferMin)
  let spent = 0

  for (const scored of input.scored) {
    const chunks = splitIntoBlocks(scored.scheduleMin, input.profile)
    const wantsStage = scored.task.areaId !== null && input.stageAreaIds.has(scored.task.areaId)
    let placedAny = false

    // The honest answer for a task on the wrong side of the day, before any gap is tried.
    if (gaps.freeFor(wantsStage) === 0) {
      unplaced.push({
        taskId: scored.task.id,
        taskTitle: scored.task.title,
        reason: wantsStage
          ? 'no internship hours left on this day'
          : 'this day is internship hours only — plan it before or after them',
        minutes: scored.scheduleMin
      })
      continue
    }

    for (const chunk of chunks) {
      const size = Math.max(input.profile.minimumBlockMin, chunk)

      if (spent + size > budget) {
        unplaced.push({
          taskId: scored.task.id,
          taskTitle: scored.task.title,
          reason: placedAny ? 'partially placed — the rest did not fit today' : 'no-room',
          minutes: size
        })
        break
      }

      const slot = gaps.take(size, wantsStage)
      if (!slot) {
        unplaced.push({
          taskId: scored.task.id,
          taskTitle: scored.task.title,
          reason: wantsStage
            ? 'no internship gap long enough was left'
            : 'no gap long enough outside the internship hours',
          minutes: size
        })
        break
      }

      blocks.push({
        taskId: scored.task.id,
        areaId: scored.task.areaId,
        date: input.date,
        startMin: slot.startMin,
        endMin: slot.endMin,
        kind: 'task',
        source: 'planner',
        score: scored.score,
        explanation: explain(scored)
      })

      spent += size
      placedAny = true
    }
  }

  return {
    blocks: blocks.sort((a, b) => a.startMin - b.startMin),
    unplaced,
    bufferMin: input.window.bufferMin,
    plannedMin: spent
  }
}
