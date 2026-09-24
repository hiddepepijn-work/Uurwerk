/**
 * Tracked time, sliced by area and by organization — independently.
 *
 * A deliberate second service rather than more parameters on StatsService: the existing
 * totals answer "how much did I work", which every screen already depends on, and this
 * answers "how much of it was what, and for whom". Keeping them apart means the new
 * question cannot change the answer to the old one.
 *
 * The two dimensions never imply each other. Maasarend hosts both the internship and work
 * that is not the internship, so filtering by organization tells you nothing about whether
 * the time counts as stage hours, and filtering by area tells you nothing about who it was
 * for. Every figure here comes from the segment's own stored classification, so historical
 * totals stay put when a task is reclassified later.
 */

// The shapes live in the contract: the Statistics screen renders them, and the renderer may
// import from there and nowhere else.
import type {
  Breakdown,
  BreakdownFilter,
  IsoDate,
  IsoWeek,
  TimeSegment
} from '../contract/types.js'
import type { Store } from '../db/index.js'
import { dayRange, overlapMinutes, weekRange } from '../util/time.js'

export type { Breakdown, BreakdownFilter }

export const UNASSIGNED = 'unassigned'

/** `stage::organization-maasarend` — internship work for one employer. */
export const seriesKey = (areaId: string | null, organizationId: string | null): string =>
  `${areaId ?? UNASSIGNED}::${organizationId ?? UNASSIGNED}`

export class BreakdownService {
  constructor(private readonly store: Store) {}

  day(date: IsoDate, filter: BreakdownFilter = {}): Breakdown {
    const { startMs, endMs } = dayRange(date)
    return this.range(startMs, endMs, filter)
  }

  week(week: IsoWeek, filter: BreakdownFilter = {}): Breakdown {
    const { startMs, endMs } = weekRange(week)
    return this.range(startMs, endMs, filter)
  }

  range(startMs: number, endMs: number, filter: BreakdownFilter = {}): Breakdown {
    const now = Date.now()
    const out: Breakdown = {
      totalMin: 0,
      stageMin: 0,
      byArea: {},
      byOrganization: {},
      byWorkType: {},
      byAreaAndOrganization: {}
    }

    for (const segment of this.store.tracking.segmentsInRange(startMs, endMs)) {
      const context = this.contextFor(segment)
      if (!this.matches(segment, context, filter)) continue

      const minutes = overlapMinutes(segment.startedAt, segment.endedAt ?? now, startMs, endMs)
      if (minutes === 0) continue

      out.totalMin += minutes
      // From the segment's own snapshot, not from the area's current setting.
      if (segment.countsAsStageHours) out.stageMin += minutes

      add(out.byArea, segment.areaId ?? UNASSIGNED, minutes)
      add(out.byOrganization, context.organizationId ?? UNASSIGNED, minutes)
      add(out.byWorkType, context.workTypeId ?? UNASSIGNED, minutes)
      add(out.byAreaAndOrganization, seriesKey(segment.areaId, context.organizationId), minutes)
    }

    return out
  }

  /**
   * The organization and work type behind a segment.
   *
   * Both come from the task, and the organization from its project — a segment stores its
   * own area because reclassifying must not rewrite history, but "who it was for" is a fact
   * about the project and is allowed to follow it.
   */
  private contextFor(segment: TimeSegment): {
    organizationId: string | null
    workTypeId: string | null
  } {
    if (!segment.taskId) return { organizationId: null, workTypeId: null }
    const task = this.store.tasks.get(segment.taskId)
    return {
      organizationId: task?.organizationId ?? null,
      workTypeId: task?.workTypeId ?? null
    }
  }

  private matches(
    segment: TimeSegment,
    context: { organizationId: string | null; workTypeId: string | null },
    filter: BreakdownFilter
  ): boolean {
    return (
      wanted(filter.areaIds, segment.areaId) &&
      wanted(filter.organizationIds, context.organizationId) &&
      wanted(filter.workTypeIds, context.workTypeId)
    )
  }
}

/** An empty filter list means no filter at all; it must never mean "match nothing". */
function wanted(allowed: string[] | undefined, value: string | null): boolean {
  if (!allowed || allowed.length === 0) return true
  return allowed.includes(value ?? UNASSIGNED)
}

function add(into: Record<string, number>, key: string, minutes: number): void {
  into[key] = (into[key] ?? 0) + minutes
}
