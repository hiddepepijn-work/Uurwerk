/**
 * Everything the Statistics screen shows, assembled in one pass.
 *
 * One call rather than a dozen, because every panel has to describe the *same* range with
 * the same filters — a screen where the tiles and the chart disagree by one day is worse
 * than no screen. The service reads; it never writes and never decides anything the rest of
 * the app does not already believe.
 *
 * Two rules it inherits and does not get to reinterpret:
 *   - stage hours come from each segment's own stored classification, so reclassifying an
 *     area later never rewrites a total that was already reported
 *   - area and organization are independent; neither may be derived from the other
 */

// Every shape below is declared in the contract, because the Statistics screen renders them
// and the renderer is allowed to import from there and nowhere else.
import type {
  AreaShare,
  Bucket,
  BreakdownFilter,
  DataQuality,
  Insight,
  IsoDate,
  IsoWeek,
  ProjectShare,
  RangePreset,
  RangeRequest,
  StatisticsOverview,
  WorkTypeComparison
} from '../contract/types.js'
import type { Store } from '../db/index.js'
import { BreakdownService, UNASSIGNED } from './breakdown.js'
import {
  addDays,
  dayRange,
  fromIsoDate,
  minutesBetween,
  overlapMinutes,
  startOfIsoWeek,
  toIsoDate,
  toIsoWeek,
  weekRange
} from '../util/time.js'

export type { RangePreset, RangeRequest, StatisticsOverview }

export class StatisticsService {
  private readonly breakdown: BreakdownService

  constructor(private readonly store: Store) {
    this.breakdown = new BreakdownService(store)
  }

  overview(request: RangeRequest, filter: BreakdownFilter = {}, now = Date.now()): StatisticsOverview {
    const range = resolveRange(request, now)
    const previous = previousRange(range)

    const tracked = this.breakdown.range(range.startMs, range.endMs, filter)
    const trackedBefore = this.breakdown.range(previous.startMs, previous.endMs, filter)

    const plannedMin = this.plannedMinutes(range.days, filter)
    const plannedBefore = this.plannedMinutes(previous.days, filter)

    const screenTimeMin = this.screenMinutes(range.days)
    const areas = this.store.areas.byId()

    return {
      from: range.from,
      to: range.to,
      preset: request.preset,
      daily: range.daily,
      buckets: this.buckets(range, filter),
      tracked: { min: tracked.totalMin, previousMin: trackedBefore.totalMin },
      stage: { min: tracked.stageMin, previousMin: trackedBefore.stageMin },
      planned: { min: plannedMin, previousMin: plannedBefore },
      screenTime: { min: screenTimeMin, previousMin: this.screenMinutes(previous.days) },
      planCompletion: completion(tracked.totalMin, plannedMin),
      previousPlanCompletion: completion(trackedBefore.totalMin, plannedBefore),
      tasksCompleted: {
        min: this.completedTasks(range.startMs, range.endMs, filter),
        previousMin: this.completedTasks(previous.startMs, previous.endMs, filter)
      },
      hasScreenTime: this.store.screenTime.hasAny(),
      areas: shares(tracked.byArea, areas),
      projects: this.projects(range, filter),
      workTypes: this.workTypes(range, filter),
      quality: this.quality(range),
      insights: this.insights(range, tracked.totalMin)
    }
  }

  // ------------------------------------------------------------------ chart

  private buckets(range: ResolvedRange, filter: BreakdownFilter): Bucket[] {
    const screenByDay = this.store.screenTime.between(range.from, range.to)

    return range.buckets.map((bucket) => {
      const slice = this.breakdown.range(bucket.startMs, bucket.endMs, filter)
      const screenTimeMin = bucket.days.reduce((sum, day) => sum + (screenByDay.get(day) ?? 0), 0)

      return {
        key: bucket.key,
        label: bucket.label,
        sublabel: bucket.sublabel,
        byArea: slice.byArea,
        trackedMin: slice.totalMin,
        screenTimeMin
      }
    })
  }

  // ----------------------------------------------------------------- panels

  /** Minutes per project, biggest first, with everything unassigned folded into one row. */
  private projects(range: ResolvedRange, filter: BreakdownFilter): ProjectShare[] {
    const now = Date.now()
    const areas = this.store.areas.byId()
    const totals = new Map<string, { minutes: number; countsAsStageHours: boolean }>()

    for (const segment of this.store.tracking.segmentsInRange(range.startMs, range.endMs)) {
      if (!this.passes(segment.taskId, segment.areaId, filter)) continue

      const minutes = overlapMinutes(
        segment.startedAt,
        segment.endedAt ?? now,
        range.startMs,
        range.endMs
      )
      if (minutes === 0) continue

      const task = segment.taskId ? this.store.tasks.get(segment.taskId) : null
      const key = task?.projectId ?? UNASSIGNED
      const current = totals.get(key)
      const countsAsStageHours =
        current?.countsAsStageHours ||
        (segment.areaId ? (areas.get(segment.areaId)?.countsAsStageHours ?? false) : false)

      totals.set(key, { minutes: (current?.minutes ?? 0) + minutes, countsAsStageHours })
    }

    return [...totals.entries()]
      .map(([projectId, value]): ProjectShare => ({
        projectId: projectId === UNASSIGNED ? null : projectId,
        name:
          projectId === UNASSIGNED
            ? 'No project'
            : (this.store.projects.get(projectId)?.name ?? 'Removed project'),
        minutes: value.minutes,
        countsAsStageHours: value.countsAsStageHours
      }))
      .sort((a, b) => b.minutes - a.minutes)
  }

  /**
   * Planned against actual, per work type.
   *
   * The comparison a weekly review actually turns on: "development always runs over" is
   * something you can act on, where "you worked 31 hours" is not.
   */
  private workTypes(range: ResolvedRange, filter: BreakdownFilter): WorkTypeComparison[] {
    const actual = this.breakdown.range(range.startMs, range.endMs, filter).byWorkType
    const planned = new Map<string, number>()

    for (const block of this.store.plans.acceptedBlocksForDays(range.days)) {
      if (block.kind !== 'task' || !block.taskId) continue
      const task = this.store.tasks.get(block.taskId)
      if (!task) continue
      if (!this.passes(block.taskId, task.areaId, filter)) continue

      const key = task.workTypeId ?? UNASSIGNED
      planned.set(key, (planned.get(key) ?? 0) + (block.endMin - block.startMin))
    }

    const keys = new Set([...Object.keys(actual), ...planned.keys()])
    const names = new Map(this.store.workTypes.list(true).map((type) => [type.id, type.name]))

    return [...keys]
      .map((key): WorkTypeComparison => ({
        workTypeId: key === UNASSIGNED ? null : key,
        name: key === UNASSIGNED ? 'Unlabelled' : (names.get(key) ?? 'Removed work type'),
        plannedMin: planned.get(key) ?? 0,
        actualMin: actual[key] ?? 0
      }))
      .sort((a, b) => b.actualMin + b.plannedMin - (a.actualMin + a.plannedMin))
  }

  /**
   * How trustworthy the numbers above are.
   *
   * A dashboard that cannot say how good its own input is invites you to over-read it. Each
   * check is something you can actually fix, and the score is simply how many came back
   * clean — it is a prompt, not a grade.
   */
  private quality(range: ResolvedRange): DataQuality {
    const now = Date.now()
    const segments = this.store.tracking.segmentsInRange(range.startMs, range.endMs)

    const segmentsWithoutTask = segments.filter((segment) => !segment.taskId).length
    const openTrackingRuns = Math.max(0, this.store.tracking.openSegments().length - 1)

    const tasksWithoutEstimate = this.store.tasks
      .list({ status: 'active' })
      .filter((task) => task.estimateMin === null).length

    let categorised = 0
    let total = 0
    for (const segment of segments) {
      const minutes = overlapMinutes(
        segment.startedAt,
        segment.endedAt ?? now,
        range.startMs,
        range.endMs
      )
      if (minutes === 0) continue
      total += minutes

      const task = segment.taskId ? this.store.tasks.get(segment.taskId) : null
      if (segment.areaId && task?.workTypeId) categorised += minutes
    }

    const categorisedFraction = total === 0 ? 1 : categorised / total
    const checks = [
      segmentsWithoutTask === 0,
      tasksWithoutEstimate === 0,
      openTrackingRuns === 0,
      categorisedFraction >= 0.9
    ]

    return {
      score: checks.filter(Boolean).length / checks.length,
      segmentsWithoutTask,
      tasksWithoutEstimate,
      openTrackingRuns,
      categorisedFraction
    }
  }

  /** A few things worth saying in a sentence. Only the ones the data actually supports. */
  private insights(range: ResolvedRange, trackedMin: number): Insight[] {
    const out: Insight[] = []

    const unplanned = this.unplannedMinutes(range)
    if (trackedMin > 0 && unplanned > 0) {
      out.push({
        kind: 'unplanned-share',
        text: `Unplanned work is ${Math.round((unplanned / trackedMin) * 100)}% of tracked time`
      })
    }

    const blocked = this.store.tasks.list({ status: 'blocked' })
    if (blocked.length > 0) {
      const unlocks = blocked.reduce(
        (sum, task) => sum + this.store.dependencies.unlockValue(task.id),
        0
      )
      if (unlocks > 0) {
        out.push({
          kind: 'blocked-unlocks',
          text: `${blocked.length} blocked task${blocked.length === 1 ? '' : 's'} hold up ${unlocks} other${unlocks === 1 ? '' : 's'}`
        })
      }
    }

    const worst = this.worstPlannedWeekday(range)
    if (worst) {
      out.push({ kind: 'overplanned-weekday', text: `${worst} is often overplanned` })
    }

    return out
  }

  /** Tracked minutes on tasks that had no planned block that day. */
  private unplannedMinutes(range: ResolvedRange): number {
    const now = Date.now()
    let unplanned = 0

    for (const date of range.days) {
      const plan = this.store.plans.accepted('day', date)
      const plannedTasks = new Set(
        (plan ? this.store.plans.blocks(plan.id) : [])
          .filter((block) => block.kind === 'task' && block.taskId)
          .map((block) => block.taskId!)
      )

      const { startMs, endMs } = dayRange(date)
      for (const segment of this.store.tracking.segmentsInRange(startMs, endMs)) {
        if (segment.taskId && plannedTasks.has(segment.taskId)) continue
        unplanned += overlapMinutes(segment.startedAt, segment.endedAt ?? now, startMs, endMs)
      }
    }

    return unplanned
  }

  /** The weekday where planned time most often exceeds what was tracked. */
  private worstPlannedWeekday(range: ResolvedRange): string | null {
    const names = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
    const overrun = new Array(7).fill(0) as number[]
    const seen = new Array(7).fill(0) as number[]
    const now = Date.now()

    for (const date of range.days) {
      const plan = this.store.plans.accepted('day', date)
      if (!plan) continue

      const plannedMin = this.store.plans
        .blocks(plan.id)
        .filter((block) => block.kind === 'task')
        .reduce((sum, block) => sum + (block.endMin - block.startMin), 0)
      if (plannedMin === 0) continue

      const { startMs, endMs } = dayRange(date)
      const trackedMin = this.store.tracking
        .segmentsInRange(startMs, endMs)
        .reduce(
          (sum, segment) =>
            sum + overlapMinutes(segment.startedAt, segment.endedAt ?? now, startMs, endMs),
          0
        )

      const weekday = (fromIsoDate(date).getDay() + 6) % 7
      seen[weekday] = (seen[weekday] ?? 0) + 1
      if (plannedMin > trackedMin) overrun[weekday] = (overrun[weekday] ?? 0) + 1
    }

    // Needs at least two examples before it is a pattern rather than one bad Tuesday.
    let worst = -1
    let worstCount = 1
    for (let index = 0; index < 7; index++) {
      if ((seen[index] ?? 0) < 2) continue
      if ((overrun[index] ?? 0) > worstCount) {
        worst = index
        worstCount = overrun[index] ?? 0
      }
    }

    return worst === -1 ? null : (names[worst] ?? null)
  }

  // --------------------------------------------------------------- helpers

  private plannedMinutes(days: IsoDate[], filter: BreakdownFilter): number {
    let minutes = 0
    for (const block of this.store.plans.acceptedBlocksForDays(days)) {
      if (block.kind !== 'task' || !block.taskId) continue
      const task = this.store.tasks.get(block.taskId)
      if (!task) continue
      if (!this.passes(block.taskId, task.areaId, filter)) continue
      minutes += block.endMin - block.startMin
    }
    return minutes
  }

  private screenMinutes(days: IsoDate[]): number {
    if (days.length === 0) return 0
    const byDay = this.store.screenTime.between(days[0]!, days[days.length - 1]!)
    return days.reduce((sum, day) => sum + (byDay.get(day) ?? 0), 0)
  }

  private completedTasks(startMs: number, endMs: number, filter: BreakdownFilter): number {
    return this.store.tasks
      .list({ status: 'done' })
      .filter((task) => task.completedAt !== null && task.completedAt >= startMs && task.completedAt < endMs)
      .filter((task) => this.passes(task.id, task.areaId, filter)).length
  }

  /** The same filter the breakdown applies, for the panels that read rows directly. */
  private passes(taskId: string | null, areaId: string | null, filter: BreakdownFilter): boolean {
    const task = taskId ? this.store.tasks.get(taskId) : null
    return (
      allows(filter.areaIds, areaId) &&
      allows(filter.organizationIds, task?.organizationId ?? null) &&
      allows(filter.workTypeIds, task?.workTypeId ?? null)
    )
  }
}

// ------------------------------------------------------------------- ranges

interface ResolvedRange {
  from: IsoDate
  to: IsoDate
  startMs: number
  endMs: number
  days: IsoDate[]
  daily: boolean
  buckets: Array<{
    key: string
    label: string
    sublabel: string
    startMs: number
    endMs: number
    days: IsoDate[]
  }>
}

/**
 * A week shows days; anything longer shows weeks.
 *
 * Twelve weeks of daily bars is a barcode, and one bar for a quarter says nothing. The
 * boundary between the two is where a column stops being readable, not a preference.
 */
export function resolveRange(request: RangeRequest, now = Date.now()): ResolvedRange {
  if (request.preset === 'week') {
    const week = toIsoWeek(now)
    const { from, to, startMs, endMs, days } = weekRange(week)
    return {
      from,
      to,
      startMs,
      endMs,
      days,
      daily: true,
      buckets: days.map((date) => {
        const bounds = dayRange(date)
        const day = fromIsoDate(date)
        return {
          key: date,
          label: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][(day.getDay() + 6) % 7]!,
          sublabel: `${day.getDate()}/${day.getMonth() + 1}`,
          startMs: bounds.startMs,
          endMs: bounds.endMs,
          days: [date]
        }
      })
    }
  }

  const weeks = request.preset === '3months' ? 13 : 4
  if (request.preset === 'custom' && request.from && request.to) {
    return customRange(request.from, request.to)
  }

  const thisMonday = startOfIsoWeek(now)
  const firstMonday = addDays(thisMonday, -7 * (weeks - 1))
  const keys: IsoWeek[] = []
  for (let index = 0; index < weeks; index++) {
    keys.push(toIsoWeek(addDays(firstMonday, index * 7)))
  }

  const first = weekRange(keys[0]!)
  const last = weekRange(keys[keys.length - 1]!)

  return {
    from: first.from,
    to: last.to,
    startMs: first.startMs,
    endMs: last.endMs,
    days: keys.flatMap((key) => weekRange(key).days),
    daily: false,
    buckets: keys.map((key) => {
      const bounds = weekRange(key)
      const monday = fromIsoDate(bounds.from)
      const sunday = fromIsoDate(bounds.to)
      const short = (date: Date): string =>
        `${date.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getMonth()]}`

      return {
        key,
        label: `Week ${key.split('-W')[1]}`,
        sublabel: `${short(monday)} – ${short(sunday)}`,
        startMs: bounds.startMs,
        endMs: bounds.endMs,
        days: bounds.days
      }
    })
  }
}

function customRange(from: IsoDate, to: IsoDate): ResolvedRange {
  const startMs = dayRange(from).startMs
  const endMs = dayRange(to).endMs
  const days: IsoDate[] = []
  for (let cursor = startMs; cursor < endMs; cursor = addDays(cursor, 1).getTime()) {
    days.push(toIsoDate(cursor))
  }

  // Short custom ranges read as days; long ones would become a barcode, so they group by week.
  const daily = days.length <= 14
  const buckets = daily
    ? days.map((date) => {
        const bounds = dayRange(date)
        const day = fromIsoDate(date)
        return {
          key: date,
          label: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][(day.getDay() + 6) % 7]!,
          sublabel: `${day.getDate()}/${day.getMonth() + 1}`,
          startMs: bounds.startMs,
          endMs: bounds.endMs,
          days: [date]
        }
      })
    : groupByWeek(days)

  return { from, to, startMs, endMs, days, daily, buckets }
}

function groupByWeek(days: IsoDate[]): ResolvedRange['buckets'] {
  const byWeek = new Map<IsoWeek, IsoDate[]>()
  for (const date of days) {
    const key = toIsoWeek(fromIsoDate(date))
    const bucket = byWeek.get(key)
    if (bucket) bucket.push(date)
    else byWeek.set(key, [date])
  }

  return [...byWeek.entries()].map(([key, dates]) => ({
    key,
    label: `Week ${key.split('-W')[1]}`,
    sublabel: `${dates[0]} – ${dates[dates.length - 1]}`,
    startMs: dayRange(dates[0]!).startMs,
    endMs: dayRange(dates[dates.length - 1]!).endMs,
    days: dates
  }))
}

/** The period immediately before, of the same length — what every delta compares against. */
function previousRange(range: ResolvedRange): { startMs: number; endMs: number; days: IsoDate[] } {
  const length = range.days.length
  const endMs = range.startMs
  const startMs = addDays(range.startMs, -length).getTime()
  const days: IsoDate[] = []
  for (let cursor = startMs; cursor < endMs; cursor = addDays(cursor, 1).getTime()) {
    days.push(toIsoDate(cursor))
  }
  return { startMs, endMs, days }
}

// -------------------------------------------------------------------- misc

function shares(
  byArea: Record<string, number>,
  areas: Map<string, { name: string; color: string }>
): AreaShare[] {
  const total = Object.values(byArea).reduce((sum, minutes) => sum + minutes, 0)

  return Object.entries(byArea)
    .map(([areaId, minutes]): AreaShare => {
      const area = areas.get(areaId)
      return {
        areaId,
        name: area?.name ?? 'No area',
        color: area?.color ?? '#6B7280',
        minutes,
        fraction: total === 0 ? 0 : minutes / total
      }
    })
    .sort((a, b) => b.minutes - a.minutes)
}

/** Null rather than zero when nothing was planned: "no plan" is not "0% done". */
function completion(trackedMin: number, plannedMin: number): number | null {
  if (plannedMin === 0) return null
  return trackedMin / plannedMin
}

const allows = (allowed: string[] | undefined, value: string | null): boolean =>
  !allowed || allowed.length === 0 || allowed.includes(value ?? UNASSIGNED)

export { minutesBetween }
