/**
 * Retro-attribution: dividing a stretch of tracked time over the tasks it actually went to.
 *
 * Choosing a task before you start assumes you know what the next hour holds. On a real day
 * you do three things at once, so the honest input comes afterwards: these tasks, roughly
 * these shares. This service turns that input into minutes, because every reader of hours in
 * this app reads `time_segments` and nothing else — a percentage stored on the side would be
 * a number no report could see.
 *
 * What it owns:
 *   1. Only closed, task-less segments that *started* inside the day are divided. Time whose
 *      task was chosen while the clock ran is a fact and is never touched.
 *   2. A split neither creates nor loses a second. The slices of a stretch are adjacent and
 *      sum to exactly its span, remainder included.
 *   3. Reversible, therefore correctable. Applying again reverts the previous split first,
 *      so the shares you give are always read against the untouched day.
 *   4. `countsAsStageHours` is resolved per slice from its own task's area, exactly as live
 *      tracking does — attributing is the moment those hours start counting.
 *   5. Every slice is marked 'estimated'. Its duration is meant; its clock times are not,
 *      and nothing downstream may present them as measured.
 */

import type {
  AttributedTask,
  Attribution,
  DayAttribution,
  IsoDate,
  NewStretch,
  Stretch,
  TaskShare,
  TimeSegment
} from '../contract/types.js'
import type { Store } from '../db/index.js'
import { MINUTE_MS, atMinuteOfDay, dayRange, minutesBetween, toIsoDate } from '../util/time.js'
import type { TrackingService } from './tracking.js'

/**
 * A stretch shorter than this is not worth cutting up.
 *
 * Two minutes over three tasks is three slices no one can read, and each rounds so coarsely
 * that the percentages stop meaning anything. Such a stretch goes whole to the largest
 * share, which is the best single answer available.
 */
const MIN_SPLITTABLE_MS = 2 * MINUTE_MS

interface Cut {
  taskId: string | null
  ms: number
}

export class AttributionService {
  constructor(
    private readonly store: Store,
    private readonly tracking: TrackingService
  ) {}

  // -------------------------------------------------------------------- read

  /** Where the day's minutes stand, and which of them the end-of-day step may divide. */
  day(date: IsoDate): DayAttribution {
    const { startMs, endMs } = dayRange(date)
    const now = Date.now()

    let unattributedMin = 0
    let trackedMin = 0
    let estimatedMin = 0
    const byTask = new Map<string, AttributedTask>()

    for (const segment of this.store.tracking.segmentsInRange(startMs, endMs)) {
      const from = Math.max(segment.startedAt, startMs)
      const to = Math.min(segment.endedAt ?? now, endMs)
      const minutes = minutesBetween(from, to)
      if (minutes === 0) continue

      if (!segment.taskId) {
        unattributedMin += minutes
        continue
      }

      if (segment.attribution === 'estimated') estimatedMin += minutes
      else trackedMin += minutes

      const existing = byTask.get(segment.taskId)
      if (existing) {
        existing.minutes += minutes
        // A task worked both ways is only as precise as its softest half.
        if (segment.attribution === 'estimated') existing.attribution = 'estimated'
      } else {
        byTask.set(segment.taskId, {
          taskId: segment.taskId,
          taskTitle: segment.taskTitle ?? 'Untitled task',
          projectName: segment.projectName,
          areaName: segment.areaName,
          minutes,
          countsAsStageHours: segment.countsAsStageHours,
          attribution: segment.attribution
        })
      }
    }

    return {
      date,
      unattributedMin,
      trackedMin,
      estimatedMin,
      tasks: [...byTask.values()].sort((a, b) => b.minutes - a.minutes),
      shares: this.sharesFrom(date)
    }
  }

  // ------------------------------------------------------------------- write

  /**
   * Divides the day's unattributed time over `shares`, replacing any previous division.
   *
   * Shares need not reach 100. What is left over stays a task-less slice: an honest "I do
   * not know what this hour was" that counts toward hours worked and toward no task, rather
   * than being quietly rounded onto whichever task happened to be listed first.
   */
  apply(date: IsoDate, shares: TaskShare[]): DayAttribution {
    const clean = normalise(shares)

    this.store.db.transaction(() => {
      // Always against the untouched day: the shares describe the whole stretch, not what
      // is left of it after the last attempt.
      this.revertWithin(date)
      if (clean.length === 0) return

      const [startMs, endMs] = rangeOf(date)
      for (const stretch of this.store.tracking.unattributedInRange(startMs, endMs)) {
        this.divide(stretch, clean, 'estimated')
      }

      for (const share of clean) this.markInProgress(share.taskId)
    })

    this.tracking.notifyEdited()
    return this.day(date)
  }

  /** Undoes the day's division, putting every stretch back the way it was tracked. */
  revert(date: IsoDate): DayAttribution {
    this.store.db.transaction(() => this.revertWithin(date))
    this.tracking.notifyEdited()
    return this.day(date)
  }

  // ------------------------------------------------------------- one stretch

  /**
   * One stretch, as a person recognises it: a span of the day and what it went to.
   *
   * Takes either a group id or the id of any slice in it, because the caller is a click on a
   * block in the week grid and that block is one slice of something whose shape it does not
   * know.
   */
  stretch(id: string): Stretch | null {
    const slices = this.slicesOf(id)
    if (slices.length === 0) return null

    const startedAt = Math.min(...slices.map((slice) => slice.startedAt))
    const running = slices.some((slice) => slice.endedAt === null)
    const endedAt = running
      ? Date.now()
      : Math.max(...slices.map((slice) => slice.endedAt ?? slice.startedAt))

    const date = toIsoDate(startedAt)
    const dayStart = dayRange(date).startMs
    const spanMs = slices.reduce((sum, slice) => sum + sliceMs(slice), 0)

    const perTask = new Map<string, AttributedTask>()
    for (const slice of slices) {
      if (!slice.taskId) continue
      const existing = perTask.get(slice.taskId)
      if (existing) {
        existing.minutes += slice.durationMin
        continue
      }
      perTask.set(slice.taskId, {
        taskId: slice.taskId,
        taskTitle: slice.taskTitle ?? 'Untitled task',
        projectName: slice.projectName,
        areaName: slice.areaName,
        minutes: slice.durationMin,
        countsAsStageHours: slice.countsAsStageHours,
        attribution: slice.attribution
      })
    }

    return {
      id:
        slices.find((slice) => slice.attributionGroup !== null)?.attributionGroup ?? slices[0]!.id,
      date,
      startMin: Math.round((startedAt - dayStart) / MINUTE_MS),
      // Past midnight wraps to a smaller number, which is how the editor reads it back.
      endMin: Math.round((endedAt - dayStart) / MINUTE_MS) % (24 * 60),
      durationMin: minutesBetween(startedAt, endedAt),
      attribution: slices[0]!.attribution,
      shares: sharesOfSlices(slices, spanMs),
      tasks: [...perTask.values()].sort((a, b) => b.minutes - a.minutes),
      note: slices.map((slice) => slice.note).find((note) => note !== null) ?? null,
      running
    }
  }

  /**
   * Hours for a stretch that was never tracked — the morning you forgot to press START.
   *
   * Marked 'manual', which is what keeps it out of the end-of-day division: you have already
   * said what these hours were, and re-dividing them by tonight's percentages would throw
   * that answer away. It gets its own run, because a run is one continuous working stretch
   * and this was one.
   */
  addStretch(input: NewStretch): Stretch {
    const { startedAt, endedAt } = spanOf(input.date, input.startMin, input.endMin)
    if (endedAt <= startedAt) throw new Error('A stretch has to be at least a minute long.')
    this.refuseOverlap(startedAt, endedAt, null)

    const clean = normalise(input.shares)

    const id = this.store.db.transaction(() => {
      const run = this.store.tracking.startRun(startedAt)
      this.store.tracking.endRun(run.id, endedAt)

      const segment = this.store.tracking.startSegment({
        trackingRunId: run.id,
        taskId: null,
        areaId: null,
        countsAsStageHours: false,
        at: startedAt,
        endedAt,
        completionReason: 'stopped',
        attribution: 'manual',
        attributionGroup: null
      })

      if (input.note?.trim()) {
        this.store.tracking.updateSegment(segment.id, { note: input.note.trim() })
      }

      this.divide(this.store.tracking.getSegment(segment.id)!, clean, 'manual')
      for (const share of clean) this.markInProgress(share.taskId)
      return segment.id
    })

    this.tracking.notifyEdited()
    return this.stretch(id)!
  }

  /**
   * Moves, resizes and re-divides one stretch, leaving the rest of the day alone.
   *
   * Changing the span of a measured stretch promotes it to 'manual': the clock said one thing
   * and you have said another, and from then on these are hours you stand behind rather than
   * hours the app observed. Re-dividing without touching the span leaves the kind alone,
   * because the span is still exactly what was measured.
   */
  updateStretch(id: string, input: NewStretch): Stretch {
    const slices = this.slicesOf(id)
    if (slices.length === 0) throw new Error('That stretch no longer exists.')
    if (slices.some((slice) => slice.endedAt === null)) {
      throw new Error('This one is still running. Stop the timer before editing it.')
    }

    const wasStart = Math.min(...slices.map((slice) => slice.startedAt))
    const wasEnd = Math.max(...slices.map((slice) => slice.endedAt ?? slice.startedAt))
    const { startedAt, endedAt } = spanOf(input.date, input.startMin, input.endMin)
    if (endedAt <= startedAt) throw new Error('A stretch has to be at least a minute long.')

    const moved = startedAt !== wasStart || endedAt !== wasEnd
    const kind: Attribution = slices[0]!.attribution === 'manual' || moved ? 'manual' : 'estimated'

    this.refuseOverlap(startedAt, endedAt, new Set(slices.map((slice) => slice.id)))

    const clean = normalise(input.shares)
    const anchorId = this.store.db.transaction(() => {
      const anchor = this.mergeSlices(slices, startedAt, endedAt)
      if (input.note !== undefined) {
        this.store.tracking.updateSegment(anchor.id, { note: input.note?.trim() || null })
      }
      this.divide(this.store.tracking.getSegment(anchor.id)!, clean, kind)
      for (const share of clean) this.markInProgress(share.taskId)
      this.restretchRun(anchor.trackingRunId)
      return anchor.id
    })

    this.tracking.notifyEdited()
    return this.stretch(anchorId)!
  }

  /** Deletes a stretch and every slice of it, and its run if nothing else was in it. */
  removeStretch(id: string): void {
    const slices = this.slicesOf(id)
    if (slices.length === 0) return

    this.store.db.transaction(() => {
      const runIds = new Set(slices.map((slice) => slice.trackingRunId))
      for (const slice of slices) this.store.tracking.removeSegment(slice.id)

      for (const runId of runIds) {
        if (this.store.tracking.segmentsForRun(runId).length === 0) {
          this.store.tracking.removeRun(runId)
        } else {
          this.restretchRun(runId)
        }
      }
    })

    this.tracking.notifyEdited()
  }

  // --------------------------------------------------------- stretch helpers

  /**
   * Every slice of the stretch the given id belongs to.
   *
   * An id that is not part of a group resolves to the single segment it names, so a stretch
   * tracked in one piece can be divided from the same editor as one that already was.
   */
  private slicesOf(id: string): TimeSegment[] {
    const grouped = this.store.tracking.segmentsInGroup(id)
    if (grouped.length > 0) return grouped

    const one = this.store.tracking.getSegment(id)
    if (!one) return []
    return one.attributionGroup ? this.store.tracking.segmentsInGroup(one.attributionGroup) : [one]
  }

  /**
   * Refuses hours that would be counted twice.
   *
   * Adding a forgotten morning over a stretch you did track inflates every total downstream,
   * the supervisor's document included — and invisibly, because both entries look perfectly
   * reasonable on their own. Better to name the stretch that is in the way.
   */
  private refuseOverlap(startedAt: number, endedAt: number, ignore: Set<string> | null): void {
    for (const other of this.store.tracking.segmentsInRange(startedAt, endedAt)) {
      if (ignore?.has(other.id)) continue
      const otherEnd = other.endedAt ?? Date.now()
      if (otherEnd <= startedAt || other.startedAt >= endedAt) continue

      const named = other.taskTitle ? ' on ' + JSON.stringify(other.taskTitle) : ''
      throw new Error(
        'These hours overlap time already recorded from ' +
          clockOf(other.startedAt) +
          ' to ' +
          clockOf(otherEnd) +
          named +
          '. Adjust the times, or edit that stretch instead.'
      )
    }
  }

  /** Folds a stretch's slices back into one segment covering the given span. */
  private mergeSlices(slices: TimeSegment[], startedAt: number, endedAt: number): TimeSegment {
    const groupId = slices[0]!.attributionGroup
    const anchor = (groupId && slices.find((slice) => slice.id === groupId)) || slices[0]!

    for (const slice of slices) {
      if (slice.id !== anchor.id) this.store.tracking.removeSegment(slice.id)
    }

    return this.store.tracking.updateSegment(anchor.id, {
      taskId: null,
      areaId: null,
      countsAsStageHours: false,
      startedAt,
      endedAt,
      attribution: 'tracked',
      attributionGroup: null
    })
  }

  /** Pulls a run's bounds back over whatever segments it still holds. */
  private restretchRun(runId: string): void {
    const segments = this.store.tracking.segmentsForRun(runId)
    if (segments.length === 0) return

    const from = Math.min(...segments.map((segment) => segment.startedAt))
    const open = segments.some((segment) => segment.endedAt === null)
    const to = open ? null : Math.max(...segments.map((segment) => segment.endedAt ?? from))
    this.store.tracking.setRunSpan(runId, from, to)
  }

  // --------------------------------------------------------------- internals

  /**
   * Cuts one stretch into adjacent slices.
   *
   * The original row is reused for the largest share rather than for the first, and keeps its
   * id. Screenshots point at a segment (migration 008), so whichever slice inherits the row
   * inherits the stretch's frames — and the task you spent most of the stretch on is the best
   * single guess for what those frames show. A task-less remainder never takes that role.
   */
  private divide(stretch: TimeSegment, shares: TaskShare[], kind: Attribution): void {
    const spanMs = sliceMs(stretch)
    if (spanMs <= 0) return

    const cuts = this.plan(spanMs, shares)
    // No shares to divide by. A hand-entered stretch still has to keep its kind and its
    // group, or the day-wide split would read those hours as untasked time awaiting an
    // answer and hand them to tonight's percentages.
    if (cuts.length === 0) {
      if (kind !== 'tracked') {
        this.store.tracking.updateSegment(stretch.id, {
          taskId: null,
          areaId: null,
          countsAsStageHours: false,
          attribution: kind,
          attributionGroup: stretch.id
        })
      }
      return
    }

    const anchorIndex = anchorFor(cuts)

    let at = stretch.startedAt
    const bounds = cuts.map((cut) => {
      const from = at
      at += cut.ms
      return { from, to: at }
    })
    // Absorb integer drift into the last slice, so the stretch still ends where it ended.
    bounds[bounds.length - 1]!.to = stretch.endedAt ?? at

    cuts.forEach((cut, index) => {
      const { from, to } = bounds[index]!
      const { area, countsAsStageHours } = this.tracking.resolveArea(cut.taskId)

      if (index === anchorIndex) {
        this.store.tracking.updateSegment(stretch.id, {
          taskId: cut.taskId,
          areaId: area?.id ?? null,
          countsAsStageHours,
          startedAt: from,
          endedAt: to,
          attribution: kind,
          attributionGroup: stretch.id
        })
        return
      }

      this.store.tracking.startSegment({
        trackingRunId: stretch.trackingRunId,
        taskId: cut.taskId,
        areaId: area?.id ?? null,
        countsAsStageHours,
        planBlockId: stretch.planBlockId,
        at: from,
        endedAt: to,
        completionReason: stretch.completionReason,
        attribution: kind,
        attributionGroup: stretch.id
      })
    })
  }

  /**
   * How many milliseconds each task gets out of one stretch.
   *
   * Largest remainder, so the slices sum to exactly the claimed total and no task is
   * systematically shorted by rounding. A stretch too short to divide legibly goes whole to
   * the biggest share instead of being cut into unreadable fragments.
   */
  private plan(spanMs: number, shares: TaskShare[]): Cut[] {
    const totalPct = shares.reduce((sum, share) => sum + share.sharePct, 0)
    if (totalPct === 0) return []

    if (spanMs < MIN_SPLITTABLE_MS) {
      const biggest = shares.reduce((best, share) =>
        share.sharePct > best.sharePct ? share : best
      )
      return [{ taskId: biggest.taskId, ms: spanMs }]
    }

    // Over-100 makes the total the denominator, so 60/60 divides a stretch half and half.
    // That is what someone typing it plainly means, and it keeps the sheet free-typed.
    const claimedMs = Math.round((spanMs * Math.min(totalPct, 100)) / 100)
    const exact = shares.map((share) => (claimedMs * share.sharePct) / totalPct)
    const floors = exact.map((value) => Math.floor(value))
    let left = claimedMs - floors.reduce((sum, ms) => sum + ms, 0)

    // Biggest fractional part first — the standard tie-break, and the only one that cannot
    // be swayed by the order the tasks happened to be added in.
    const order = exact
      .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
      .sort((a, b) => b.fraction - a.fraction)

    for (const { index } of order) {
      if (left <= 0) break
      floors[index]! += 1
      left -= 1
    }

    const cuts: Cut[] = shares
      .map((share, index) => ({ taskId: share.taskId as string | null, ms: floors[index]! }))
      .filter((cut) => cut.ms > 0)

    const remainderMs = spanMs - claimedMs
    if (remainderMs > 0) cuts.push({ taskId: null, ms: remainderMs })

    return cuts
  }

  /**
   * Merges every split stretch of the day back into the single segment it was.
   *
   * A stretch counts as the day's only if it *began* that day. Reverting one that merely
   * reaches into today would undo a division made last night, which nobody asked for.
   */
  private revertWithin(date: IsoDate): void {
    for (const slices of this.splitStretchesFor(date)) {
      const groupId = slices[0]!.attributionGroup!
      const from = Math.min(...slices.map((slice) => slice.startedAt))
      const to = Math.max(...slices.map((slice) => slice.endedAt ?? slice.startedAt))

      // The anchor carries the original id, so it is the row every screenshot still points
      // at. Restoring that row rather than building a fresh one keeps those links intact.
      const anchor = slices.find((slice) => slice.id === groupId) ?? slices[0]!

      for (const slice of slices) {
        if (slice.id !== anchor.id) this.store.tracking.removeSegment(slice.id)
      }

      this.store.tracking.updateSegment(anchor.id, {
        taskId: null,
        areaId: null,
        countsAsStageHours: false,
        startedAt: from,
        endedAt: to,
        attribution: 'tracked',
        attributionGroup: null
      })
    }
  }

  /** The day's split stretches, each as its own list of slices. */
  private splitStretchesFor(date: IsoDate): TimeSegment[][] {
    const [startMs, endMs] = rangeOf(date)
    const out: TimeSegment[][] = []

    for (const groupId of this.store.tracking.attributionGroupsInRange(
      startMs,
      endMs,
      'estimated'
    )) {
      const slices = this.store.tracking.segmentsInGroup(groupId)
      if (slices.length === 0) continue

      const begun = Math.min(...slices.map((slice) => slice.startedAt))
      if (begun < startMs || begun >= endMs) continue

      out.push(slices)
    }

    return out
  }

  /**
   * The shares behind the day's existing split, recovered from the slices themselves.
   *
   * Reopening the step has to show what you last said, and the slices are the only record of
   * it — storing the percentages separately would give two answers that could disagree.
   * Shares are relative to the whole stretch, so a day left partly unattributed comes back
   * with shares that still do not reach 100.
   */
  private sharesFrom(date: IsoDate): TaskShare[] {
    const stretches = this.splitStretchesFor(date)
    if (stretches.length === 0) return []

    const spanMs = stretches.reduce((sum, slices) => sum + stretchSpanMs(slices), 0)
    if (spanMs === 0) return []

    return sharesOfSlices(stretches.flat(), spanMs)
  }

  /** Same rule as live tracking: working on a task moves it out of 'open' by itself. */
  private markInProgress(taskId: string): void {
    const task = this.store.tasks.get(taskId)
    if (task && task.status === 'open') {
      this.store.tasks.update(taskId, { status: 'in_progress' })
    }
  }
}

// -------------------------------------------------------------------- helpers

const rangeOf = (date: IsoDate): [number, number] => {
  const { startMs, endMs } = dayRange(date)
  return [startMs, endMs]
}

/** Local clock time, for an error message a person has to act on. */
const clockOf = (ms: number): string =>
  new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

/**
 * The instants a day-and-minute pair names.
 *
 * An end *earlier* than the start reads as the following morning rather than as an error: an
 * evening running into the next day is a real shape, the tracking service allows it, and
 * refusing it would make 23:30-00:30 inexpressible.
 *
 * An end *equal* to the start does not wrap. Reading 09:00-09:00 as a full day around the
 * clock would turn a slip of the keyboard into twenty-four billed hours; it is an empty span,
 * and the callers refuse it as one.
 */
function spanOf(
  date: IsoDate,
  startMin: number,
  endMin: number
): { startedAt: number; endedAt: number } {
  const startedAt = atMinuteOfDay(date, startMin)
  const endedAt =
    endMin < startMin
      ? atMinuteOfDay(date, endMin) + 24 * 60 * MINUTE_MS
      : atMinuteOfDay(date, endMin)
  return { startedAt, endedAt }
}

/**
 * The shares a set of slices represents, as whole percents of `spanMs`.
 *
 * Recovered from the slices rather than stored beside them: two records of the same division
 * are two records that can disagree, and the slices are the one the reports read. Shares of a
 * partly untasked stretch legitimately fall short of 100.
 */
function sharesOfSlices(slices: TimeSegment[], spanMs: number): TaskShare[] {
  if (spanMs <= 0) return []

  const perTask = new Map<string, number>()
  for (const slice of slices) {
    if (!slice.taskId) continue
    perTask.set(slice.taskId, (perTask.get(slice.taskId) ?? 0) + sliceMs(slice))
  }

  return [...perTask.entries()]
    .map(([taskId, ms]) => ({ taskId, sharePct: Math.round((ms / spanMs) * 100) }))
    .filter((share) => share.sharePct > 0)
    .sort((a, b) => b.sharePct - a.sharePct)
}

const sliceMs = (segment: TimeSegment): number =>
  Math.max(0, (segment.endedAt ?? segment.startedAt) - segment.startedAt)

const stretchSpanMs = (slices: TimeSegment[]): number =>
  slices.reduce((sum, slice) => sum + sliceMs(slice), 0)

/** The slice that inherits the original row: the longest one that actually has a task. */
const anchorFor = (cuts: Cut[]): number => {
  let best = 0
  cuts.forEach((cut, index) => {
    if (cut.taskId === null) return
    if (cuts[best]!.taskId === null || cut.ms > cuts[best]!.ms) best = index
  })
  return best
}

/**
 * Cleans the sheet's input: one entry per task, nothing empty, nothing negative.
 *
 * Duplicates are added rather than dropped — listing a task twice at 20% means 40%, which is
 * the only reading that does not silently discard half of what was typed.
 */
function normalise(shares: TaskShare[]): TaskShare[] {
  const merged = new Map<string, number>()
  for (const share of shares) {
    if (!share.taskId) continue
    const pct = Math.max(0, Math.round(share.sharePct))
    if (pct === 0) continue
    merged.set(share.taskId, (merged.get(share.taskId) ?? 0) + pct)
  }
  return [...merged.entries()].map(([taskId, sharePct]) => ({ taskId, sharePct }))
}
