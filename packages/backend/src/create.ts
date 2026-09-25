/**
 * The backend as one object: the store plus every service, wired once.
 *
 * Shared instances matter here, not just convenience — see the comments below. Whoever
 * starts the backend (the Electron main process, the server) says where the database is.
 */

import { openStore, type Store } from '@core/db/index.js'
import { AttributionService } from '@core/services/attribution.js'
import { BreakdownService } from '@core/services/breakdown.js'
import { CalendarService } from '@core/services/calendar/index.js'
import { DayReviewService } from '@core/services/day-review.js'
import { ProjectOverviewService } from '@core/services/project-overview.js'
import { PublishService } from '@core/services/publish.js'
import { StatisticsService } from '@core/services/statistics.js'
import { PlanEditService } from '@core/services/plan-edit.js'
import { PlanningService } from '@core/services/planning.js'
import { TrackingService } from '@core/services/tracking.js'
import { PlannerService } from '@core/services/planner/index.js'
import { SnapshotService } from '@core/services/snapshot.js'
import { StatsService } from '@core/services/stats.js'
import { TimerService } from '@core/services/timer.js'
import { ReportAggregator } from '@core/report/aggregate.js'

export interface Backend {
  store: Store
  timer: TimerService
  attribution: AttributionService
  breakdown: BreakdownService
  statistics: StatisticsService
  calendar: CalendarService
  stats: StatsService
  planning: PlanningService
  planEdit: PlanEditService
  publishService: PublishService
  snapshot: SnapshotService
  reports: ReportAggregator
  days: DayReviewService
  trackingService: TrackingService
  planner: PlannerService
  projectOverview: ProjectOverviewService
}

export function createBackend(dbPath: string): Backend {
  return createBackendFrom(openStore(dbPath))
}

/** Over a store that is already open — the phone opens its own, on sql.js. */
export function createBackendFrom(store: Store): Backend {
  const stats = new StatsService(store)
  const planning = new PlanningService(store, stats)
  // One tracking service, shared: the timer façade wraps this same instance so both
  // surfaces see the same open run and emit from the same listener set.
  const trackingService = new TrackingService(store)
  // One review service, shared with the publisher: the numbers the wizard shows you are
  // the numbers that get uploaded, by construction rather than by coincidence.
  const days = new DayReviewService(store)

  return {
    store,
    stats,
    attribution: new AttributionService(store, trackingService),
    breakdown: new BreakdownService(store),
    statistics: new StatisticsService(store),
    calendar: new CalendarService(store),
    planning,
    planEdit: new PlanEditService(store),
    publishService: new PublishService(store, days),
    trackingService,
    timer: new TimerService(store, trackingService),
    snapshot: new SnapshotService(store, stats),
    reports: new ReportAggregator(store, stats, planning),
    days,
    planner: new PlannerService(store),
    projectOverview: new ProjectOverviewService(store)
  }
}
