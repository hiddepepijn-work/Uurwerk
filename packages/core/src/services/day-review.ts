/**
 * The end-of-day review.
 *
 * Feeds step 1 of the wizard and, unlike the weekly report, is about a single day: what was
 * worked on, how the day actually split between focus and breaks, and what material exists
 * to show for it.
 *
 * Publishing lives here too, because the gate belongs next to the data it guards. A day is
 * visible to the supervisor only when ALL of these hold:
 *
 *   1. day_reports.published_at is set        — you pressed Publish
 *   2. the matching publish flag is true      — you ticked that category
 *   3. for images: artifact.included is true  — you approved that specific frame
 *
 * Any one of them false means the item stays on this machine. Defaults are all false.
 */

import type {
  Activity,
  Artifact,
  DayReport,
  DayReview,
  IsoDate,
  PublishFlags
} from '../contract/types.js'
import type { Store } from '../db/index.js'
import { dayRange, minutesBetween, overlapMinutes } from '../util/time.js'
import { FOCUS_BLOCK_MIN } from './stats.js'

export class DayReviewService {
  constructor(private readonly store: Store) {}

  review(date: IsoDate): DayReview {
    const { startMs, endMs } = dayRange(date)
    const now = Date.now()
    const sessions = this.store.tracking.segmentsInRange(startMs, endMs)

    const clipped = sessions.map((session) => {
      const from = Math.max(session.startedAt, startMs)
      const to = Math.min(session.endedAt ?? now, endMs)
      return { session, from, to, minutes: minutesBetween(from, to) }
    })

    const trackedMin = clipped.reduce((sum, s) => sum + s.minutes, 0)
    const focusMin = clipped
      .filter((s) => s.minutes >= FOCUS_BLOCK_MIN)
      .reduce((sum, s) => sum + s.minutes, 0)

    // Breaks are the gaps *inside* the working day: first start to last end, minus what was
    // tracked. Time before you started and after you stopped is not a break, it is not work.
    const firstStart = clipped.length ? Math.min(...clipped.map((s) => s.from)) : 0
    const lastEnd = clipped.length ? Math.max(...clipped.map((s) => s.to)) : 0
    const breakMin = clipped.length ? Math.max(0, minutesBetween(firstStart, lastEnd) - trackedMin) : 0

    const screenshots = this.store.artifacts.listByDay(date, 'screenshot')
    const completedTasks = this.store.tasks
      .list({ status: 'done' })
      .filter((t) => t.completedAt !== null && t.completedAt >= startMs && t.completedAt < endMs)

    return {
      date,
      trackedMin,
      focusMin,
      breakMin,
      sessionCount: sessions.length,
      // What the attribution step exists for. Reported here so the wizard can skip that
      // step on a day where every minute already knows which task it belongs to.
      unattributedMin: clipped
        .filter((s) => s.session.taskId === null)
        .reduce((sum, s) => sum + s.minutes, 0),
      completedTasks: completedTasks.length,
      totalTasks: new Set(sessions.map((s) => s.taskId).filter(Boolean)).size,
      topActivities: this.topActivities(date),
      screenshotCount: screenshots.length,
      includedScreenshotCount: screenshots.filter((s) => s.included).length,
      hasTimelapse: this.store.artifacts.listByDay(date, 'timelapse').length > 0
    }
  }

  /** Time per task for one day, biggest first — the wizard's "Top activities" list. */
  topActivities(date: IsoDate, limit = 5): Activity[] {
    const { startMs, endMs } = dayRange(date)
    const now = Date.now()
    const totals = new Map<string, number>()

    for (const session of this.store.tracking.segmentsInRange(startMs, endMs)) {
      const key = session.taskId ?? '__untracked__'
      const minutes = overlapMinutes(session.startedAt, session.endedAt ?? now, startMs, endMs)
      totals.set(key, (totals.get(key) ?? 0) + minutes)
    }

    return [...totals.entries()]
      .map(([taskId, minutes]): Activity => {
        const task = taskId === '__untracked__' ? null : this.store.tasks.get(taskId)
        return {
          taskId: task?.id ?? null,
          taskTitle: task?.title ?? 'Untracked',
          projectName: task?.projectName ?? null,
          priority: task?.priority ?? null,
          minutes
        }
      })
      .sort((a, b) => b.minutes - a.minutes)
      .slice(0, limit)
  }

  // ------------------------------------------------------------- publishing

  get(date: IsoDate): DayReport {
    return this.store.days.ensure(date)
  }

  saveSummary(date: IsoDate, summary: string): DayReport {
    return this.store.days.saveSummary(date, summary)
  }

  saveFlags(date: IsoDate, flags: PublishFlags): DayReport {
    return this.store.days.saveFlags(date, flags)
  }

  /**
   * The images this day is allowed to publish. Both gates applied, in order.
   * Returns an empty list unless the day is published AND screenshots were ticked.
   */
  publishableScreenshots(date: IsoDate): Artifact[] {
    const day = this.store.days.get(date)
    if (!day?.publishedAt) return []
    if (!day.flags.screenshots) return []
    return this.store.artifacts.listByDay(date, 'screenshot').filter((shot) => shot.included)
  }

  publishableTimelapse(date: IsoDate): Artifact | null {
    const day = this.store.days.get(date)
    if (!day?.publishedAt || !day.flags.timelapse) return null
    const list = this.store.artifacts.listByDay(date, 'timelapse')
    return list[list.length - 1] ?? null
  }

  /** Sets the consent stamp. The caller uploads only what publishable* returns. */
  markPublished(date: IsoDate): DayReport {
    return this.store.days.markPublished(date)
  }

  /** Revokes consent. The caller must have deleted the remote copies first. */
  unpublish(date: IsoDate): DayReport {
    this.store.published.forget(date)
    return this.store.days.clearPublished(date)
  }
}
