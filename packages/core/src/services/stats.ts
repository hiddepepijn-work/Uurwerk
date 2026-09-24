/**
 * Derived numbers: the stat cards, the Today timeline, the week totals.
 *
 * Nothing here is stored. Every figure is recomputed from sessions and planned blocks, so
 * the report and the dashboard can never disagree with each other.
 */

import type {
  DayStats,
  IsoDate,
  IsoWeek,
  TimelineSegment,
  TrackedTotals,
  WeekStats
} from '../contract/types.js'
import type { Store } from '../db/index.js'
import { dayRange, minutesBetween, overlapMinutes, weekRange } from '../util/time.js'

/** An uninterrupted stretch of at least this many minutes counts as a focus block. */
export const FOCUS_BLOCK_MIN = 25

export class StatsService {
  constructor(private readonly store: Store) {}

  /** Tracked minutes overlapping [startMs, endMs) — clipped, so midnight spans split correctly. */
  trackedMinutes(startMs: number, endMs: number): number {
    const now = Date.now()
    return this.store.tracking
      .segmentsInRange(startMs, endMs)
      .reduce(
        (total, s) => total + overlapMinutes(s.startedAt, s.endedAt ?? now, startMs, endMs),
        0
      )
  }

  day(date: IsoDate): DayStats {
    const { startMs, endMs } = dayRange(date)
    const settings = this.store.settings.get()
    const sessions = this.store.tracking.segmentsInRange(startMs, endMs)
    const now = Date.now()

    return {
      date,
      trackedMin: this.trackedMinutes(startMs, endMs),
      goalMin: settings.dailyGoalMin,
      sessionCount: sessions.length,
      focusBlocks: sessions.filter(
        (s) => overlapMinutes(s.startedAt, s.endedAt ?? now, startMs, endMs) >= FOCUS_BLOCK_MIN
      ).length
    }
  }

  week(week: IsoWeek): WeekStats {
    const { days, startMs, endMs } = weekRange(week)
    const settings = this.store.settings.get()
    const now = Date.now()
    const sessions = this.store.tracking.segmentsInRange(startMs, endMs)

    // From the accepted day plans. The flat `planned` table this used to read stopped being
    // written when the versioned plan model landed, so it reported zero for every week.
    let plannedMin = 0
    for (const minutes of this.store.plans.plannedMinutesForDays(days).values()) {
      plannedMin += minutes
    }

    return {
      week,
      plannedMin,
      trackedMin: this.trackedMinutes(startMs, endMs),
      goalMin: settings.weeklyGoalMin,
      focusBlocks: sessions.filter(
        (s) => overlapMinutes(s.startedAt, s.endedAt ?? now, startMs, endMs) >= FOCUS_BLOCK_MIN
      ).length
    }
  }

  /** The green/grey strip at the bottom of the Today screen. */
  timeline(date: IsoDate): TimelineSegment[] {
    const { startMs, endMs } = dayRange(date)
    const now = Date.now()

    return this.store.tracking.segmentsInRange(startMs, endMs).map((session) => {
      const from = Math.max(session.startedAt, startMs)
      const to = Math.min(session.endedAt ?? now, endMs)
      return {
        sessionId: session.id,
        taskTitle: session.taskTitle,
        startedAt: from,
        endedAt: to,
        durationMin: minutesBetween(from, to),
        attribution: session.attribution,
        attributionGroup: session.attributionGroup
      }
    })
  }

  /**
   * Tracked minutes split the way a supervisor report needs them.
   *
   * The split comes from each segment's own stored classification, not from the area's
   * current setting — so reclassifying an area never changes a total already reported.
   */
  totals(startMs: number, endMs: number): TrackedTotals {
    const now = Date.now()
    const byArea: Record<string, number> = {}
    let stageMin = 0
    let otherMin = 0

    for (const segment of this.store.tracking.segmentsInRange(startMs, endMs)) {
      const minutes = overlapMinutes(segment.startedAt, segment.endedAt ?? now, startMs, endMs)
      if (minutes === 0) continue

      if (segment.countsAsStageHours) stageMin += minutes
      else otherMin += minutes

      const key = segment.areaId ?? 'unassigned'
      byArea[key] = (byArea[key] ?? 0) + minutes
    }

    return { totalMin: stageMin + otherMin, stageMin, otherMin, byArea }
  }

  /** Actual minutes per task in a date range — the other half of planned-vs-actual. */
  actualMinutesByTask(week: IsoWeek): Map<string, number> {
    const { startMs, endMs } = weekRange(week)
    const now = Date.now()
    const out = new Map<string, number>()

    for (const session of this.store.tracking.segmentsInRange(startMs, endMs)) {
      if (!session.taskId) continue
      const minutes = overlapMinutes(session.startedAt, session.endedAt ?? now, startMs, endMs)
      out.set(session.taskId, (out.get(session.taskId) ?? 0) + minutes)
    }
    return out
  }
}
