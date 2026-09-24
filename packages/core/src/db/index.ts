import { Db, openDatabase } from './connection.js'
import { AreaRepo } from './repositories/areas.js'
import { ArtifactRepo } from './repositories/artifacts.js'
import { AvailabilityRepo } from './repositories/availability.js'
import { DayRepo, PublishedFileRepo } from './repositories/days.js'
import { CalendarRepo } from './repositories/calendar.js'
import { ClassificationRuleRepo } from './repositories/calendar-rules.js'
import { CommitmentRepo } from './repositories/commitments.js'
import { DependencyRepo } from './repositories/dependencies.js'
import { OrganizationRepo } from './repositories/organizations.js'
import { PlanRepo } from './repositories/plans.js'
import { WorkTypeRepo } from './repositories/work-types.js'
import { PlanningRepo } from './repositories/planning.js'
import { TrackingRepo } from './repositories/tracking.js'
import { ProjectRepo } from './repositories/projects.js'
import { ReportRepo } from './repositories/reports.js'
import { ScreenTimeRepo } from './repositories/screen-time.js'
import { SettingsRepo } from './repositories/settings.js'
import { TaskRepo } from './repositories/tasks.js'

/** Every repository, created once and handed to the services. */
/**
 * Every repository, created once and handed to the services.
 *
 * Two of the original tables have no repository any more. `sessions` and `planned` still
 * exist and still hold the pre-planner history — migrations 004 and 005 read them with raw
 * SQL — but nothing writes them and nothing reads them at runtime, and keeping accessors
 * around for that was an invitation to write code against a table that stopped moving.
 */
export interface Store {
  db: Db
  projects: ProjectRepo
  tasks: TaskRepo
  planning: PlanningRepo
  artifacts: ArtifactRepo
  reports: ReportRepo
  settings: SettingsRepo
  days: DayRepo
  published: PublishedFileRepo
  areas: AreaRepo
  dependencies: DependencyRepo
  plans: PlanRepo
  tracking: TrackingRepo
  availability: AvailabilityRepo
  /** Standing weekly commitments — shifts, classes — expanded into dated walls on read. */
  commitments: CommitmentRepo
  /** External calendars: accounts, events, and the links that keep sync from looping. */
  calendar: CalendarRepo
  /** What Uurwerk has learned about classifying appointments. Local, and forgettable. */
  calendarRules: ClassificationRuleRepo
  /** Who work is for. Independent of `areas`, which is what work counts as. */
  organizations: OrganizationRepo
  /** What the activity is, reused across every area and organization. */
  workTypes: WorkTypeRepo
  /** How long the machine was awake — context for tracked time, not tracked time. */
  screenTime: ScreenTimeRepo
}

export function createStore(db: Db): Store {
  return {
    db,
    projects: new ProjectRepo(db),
    tasks: new TaskRepo(db),
    planning: new PlanningRepo(db),
    artifacts: new ArtifactRepo(db),
    reports: new ReportRepo(db),
    settings: new SettingsRepo(db),
    days: new DayRepo(db),
    published: new PublishedFileRepo(db),
    areas: new AreaRepo(db),
    dependencies: new DependencyRepo(db),
    plans: new PlanRepo(db),
    tracking: new TrackingRepo(db),
    availability: new AvailabilityRepo(db),
    commitments: new CommitmentRepo(db),
    calendar: new CalendarRepo(db),
    calendarRules: new ClassificationRuleRepo(db),
    organizations: new OrganizationRepo(db),
    workTypes: new WorkTypeRepo(db),
    screenTime: new ScreenTimeRepo(db)
  }
}

/** Convenience for the main process and for tests (':memory:'). */
export function openStore(filename: string): Store {
  return createStore(openDatabase(filename))
}

export { Db, openDatabase } from './connection.js'
