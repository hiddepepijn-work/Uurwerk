/**
 * ★ SECURITY-CRITICAL ★
 *
 * What a published day contains, and — far more importantly — what it does not.
 *
 * The gate is a chain, and every link must hold before anything is included:
 *
 *   1. you pressed Publish for that day        (`day_reports.published_at`, stamped by the caller)
 *   2. the category is ticked                  (`day_reports.publish_flags`)
 *   3. for an image, that frame is approved    (`artifacts.included`)
 *   4. for a name, its area and project share  (`domain/sharing.ts`), for that audience
 *
 * Default is deny at every link. A missing flag is not "probably fine", an unknown area is
 * not permission, and an unapproved frame is never uploaded — it is not even read.
 *
 * This file does no IO. It decides *what* may leave; the main process decides how, which is
 * what keeps this testable and keeps the rules in one readable place.
 */

import type {
  Artifact,
  IsoDate,
  PublishAudience,
  PublishedDay,
  PublishFlags,
  PublishIndex
} from '../contract/types.js'
import type { Store } from '../db/index.js'
import { newId } from '../db/connection.js'
import { resolveAreaId, sharesWithSupervisor, sharesWithTeacher } from '../domain/sharing.js'
import { DayReviewService } from './day-review.js'

export const MASKED_LABEL = 'Overig werk'

/** A file that has been cleared for upload, with the name it will have remotely. */
export interface PublishFile {
  artifactId: string
  kind: 'screenshot' | 'timelapse'
  /** Local, for the uploader only. Never written into a payload. */
  path: string
  /**
   * Random, never derived from the date or the original filename.
   *
   * A published image behind a login is still an image with a URL, and a URL that can be
   * guessed from a date is not really behind anything.
   */
  remoteName: string
}

export interface PreparedDay {
  payload: PublishedDay
  /** The name the payload itself is stored under — also random, for the same reason. */
  payloadName: string
  files: PublishFile[]
}

export class PublishService {
  constructor(
    private readonly store: Store,
    private readonly dayReview: DayReviewService
  ) {}

  /**
   * Everything one audience would receive for one day, assembled but not sent.
   *
   * Callers use this both to upload and to show the user beforehand — the same object, so
   * the preview cannot drift away from what is actually published.
   *
   * The audience is a parameter rather than a setting, because the same day is prepared
   * twice — once for the supervisor, once for the teacher — and the two must be built by
   * the same code from the same flags, differing only where consent differs.
   */
  prepare(
    date: IsoDate,
    audience: PublishAudience = 'supervisor',
    publishedAt = Date.now()
  ): PreparedDay {
    const day = this.store.days.ensure(date)
    const flags = day.flags

    const files = this.files(date, flags)
    const payload: PublishedDay = { date, publishedAt }

    if (flags.sessions) {
      const review = this.dayReview.review(date)
      payload.trackedMin = this.stageMinutes(date)
      payload.focusMin = review.focusMin
      payload.sessionCount = review.sessionCount
    }

    if (flags.tasks) {
      const review = this.dayReview.review(date)
      payload.completedTasks = review.completedTasks
      payload.totalTasks = review.totalTasks
      payload.activities = this.activities(date, audience)
    }

    // An empty summary is not a summary; publishing a blank block says nothing and looks
    // like something went wrong.
    if (flags.summary && day.summary.trim()) payload.summary = day.summary.trim()

    const screenshots = files.filter((file) => file.kind === 'screenshot')
    if (screenshots.length > 0) payload.screenshots = screenshots.map((file) => file.remoteName)

    const timelapse = files.find((file) => file.kind === 'timelapse')
    if (timelapse) payload.timelapse = timelapse.remoteName

    return { payload, payloadName: remoteName('json'), files }
  }

  /** True when at least one category is ticked. Publishing nothing is not publishing. */
  hasAnythingToPublish(date: IsoDate): boolean {
    const flags = this.store.days.ensure(date).flags
    return Object.values(flags).some(Boolean)
  }

  /**
   * The files this day is allowed to upload.
   *
   * Frames must be both ticked as a category and approved one by one; the timelapse is a
   * single file and inherits the approval of the frames it was built from.
   */
  private files(date: IsoDate, flags: PublishFlags): PublishFile[] {
    const out: PublishFile[] = []

    if (flags.screenshots) {
      for (const shot of this.store.artifacts.listByDay(date, 'screenshot')) {
        if (!shot.included) continue
        out.push(toFile(shot, 'screenshot'))
      }
    }

    if (flags.timelapse) {
      const films = this.store.artifacts.listByDay(date, 'timelapse')
      const latest = films[films.length - 1]
      if (latest) out.push(toFile(latest, 'timelapse'))
    }

    return out
  }

  /** Stage hours only: time in Work or Personal is not part of an internship day. */
  private stageMinutes(date: IsoDate): number {
    const { startMs, endMs } = dayBounds(date)
    let minutes = 0
    for (const segment of this.store.tracking.segmentsInRange(startMs, endMs)) {
      if (!segment.countsAsStageHours) continue
      minutes += segment.durationMin
    }
    return minutes
  }

  /**
   * What the day was spent on, biggest first, with every name checked against the sharing
   * rules. Unshareable work keeps its minutes and loses its name — the total stays honest
   * without saying what the work was.
   */
  private activities(
    date: IsoDate,
    audience: PublishAudience
  ): Array<{ title: string; minutes: number }> {
    const shares = audience === 'teacher' ? sharesWithTeacher : sharesWithSupervisor
    const areas = this.store.areas.byId()
    const merged = new Map<string, number>()

    for (const activity of this.dayReview.topActivities(date, 20)) {
      const task = activity.taskId ? this.store.tasks.get(activity.taskId) : null
      const project = task?.projectId ? this.store.projects.get(task.projectId) : null
      const areaId = task ? resolveAreaId(task, project) : null
      const area = areaId ? (areas.get(areaId) ?? null) : null

      // Non-stage time does not belong in an internship day at all, named or not.
      if (!area?.countsAsStageHours) continue

      const shareable = task !== null && shares({ area, project })
      const title = shareable ? activity.taskTitle : MASKED_LABEL
      merged.set(title, (merged.get(title) ?? 0) + activity.minutes)
    }

    return [...merged.entries()]
      .map(([title, minutes]) => ({ title, minutes }))
      .sort((a, b) => b.minutes - a.minutes)
  }
}

/** The published site's entry point. Only days that are still stamped appear in it. */
export function buildIndex(
  days: Array<{ date: IsoDate; payload: string }>,
  updatedAt = Date.now()
): PublishIndex {
  return {
    updatedAt,
    days: [...days].sort((a, b) => (a.date < b.date ? 1 : -1))
  }
}

/** `9f86d081…-a1b2.jpg` — unguessable, and carrying no date, task or project in its name. */
export function remoteName(extension: string): string {
  return `${newId().replace(/-/g, '')}.${extension.replace(/^\./, '')}`
}

const toFile = (artifact: Artifact, kind: 'screenshot' | 'timelapse'): PublishFile => ({
  artifactId: artifact.id,
  kind,
  path: artifact.path,
  remoteName: remoteName(kind === 'timelapse' ? 'webm' : 'jpg')
})

/** Local midnight boundaries, kept here so this file does not depend on the day repo. */
function dayBounds(date: IsoDate): { startMs: number; endMs: number } {
  const [y, m, d] = date.split('-').map(Number)
  const start = new Date(y!, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0)
  const end = new Date(start.getTime())
  end.setDate(end.getDate() + 1)
  return { startMs: start.getTime(), endMs: end.getTime() }
}
