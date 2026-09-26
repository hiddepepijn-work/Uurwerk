/**
 * Domain types shared by every layer.
 *
 * Conventions:
 *   - timestamps are epoch milliseconds (number) — unambiguous, sortable, no timezone traps
 *   - calendar dates are local 'YYYY-MM-DD' strings — a working day is a local concept
 *   - durations are whole minutes unless the name says otherwise
 *   - minute-of-day offsets (planning grid) are 0..1440 from local midnight
 */

export type Priority = 'high' | 'medium' | 'low'
export type TaskStatus = 'open' | 'in_progress' | 'blocked' | 'done' | 'archived'
export type ArtifactKind = 'screenshot' | 'timelapse'

/** Local calendar date, 'YYYY-MM-DD'. */
export type IsoDate = string
/** ISO week key, 'YYYY-Www' e.g. '2025-W32'. */
export type IsoWeek = string

// ------------------------------------------------------------------- areas

/**
 * The life/work category above projects. Areas are the hard privacy boundary: a task in
 * an area that does not share can never be published, whatever its project says.
 *
 * The three built-in areas use fixed ids rather than generated ones, so migrations,
 * defaults and tests can refer to them across installations.
 */
export const SYSTEM_AREAS = {
  stage: 'stage',
  work: 'work',
  personal: 'personal'
} as const

export type SystemAreaId = (typeof SYSTEM_AREAS)[keyof typeof SYSTEM_AREAS]

export interface Area {
  id: string
  name: string
  color: string
  /** Whether time in this area counts toward internship hours. */
  countsAsStageHours: boolean
  defaultShareSupervisor: boolean
  /** Deliberately independent of the supervisor flag — different audience, different consent. */
  defaultShareTeacher: boolean
  sortOrder: number
  archived: boolean
}

export interface NewArea {
  id?: string
  name: string
  color?: string
  countsAsStageHours?: boolean
  defaultShareSupervisor?: boolean
  defaultShareTeacher?: boolean
}

// ----------------------------------------------------------- organizations

/**
 * Who the work is for. Deliberately **not** what it counts as.
 *
 * One organization can host several areas — the internship and other paid work for the same
 * employer are the obvious case — so nothing may derive an area from an organization, its
 * name or its id. The two are chosen separately and stored separately.
 */
export interface Organization {
  id: string
  /** Stable and unique; survives a rename of `name`. */
  slug: string
  name: string
  archived: boolean
  createdAt: number
}

export interface NewOrganization {
  id?: string
  slug?: string
  name: string
}

/** The built-in organizations. Maasarend and the school in 009, Jumbo in 012. */
export const SYSTEM_ORGANIZATIONS = {
  maasarend: 'organization-maasarend',
  hasGreenAcademy: 'organization-has-green-academy',
  jumbo: 'organization-jumbo'
} as const

// -------------------------------------------------------------- work types

/**
 * What the activity is: research, development, documentation, …
 *
 * Orthogonal to both area and organization. Research done for the internship, for the same
 * employer outside it, and for a course is one work type used three times — never three
 * near-identical records that drift apart.
 */
export interface WorkType {
  id: string
  slug: string
  name: string
  sortOrder: number
  archived: boolean
}

export interface NewWorkType {
  id?: string
  slug?: string
  name: string
}

// ---------------------------------------------------------------- projects

export interface Project {
  id: string
  name: string
  color: string
  areaId: string | null
  /**
   * Who this project's work is for. Null is a real state — a project need not belong to
   * anyone in particular — and it never implies anything about the area.
   */
  organizationId: string | null
  /**
   * Per-project override. Sharing requires BOTH this and the area's default:
   *   effective = area.defaultShareSupervisor && project.shareable
   * A project can narrow what the area allows; it can never widen it.
   */
  shareable: boolean
  archived: boolean
}

export interface NewProject {
  name: string
  color?: string
  areaId?: string | null
  organizationId?: string | null
  shareable?: boolean
}

// ------------------------------------------------------------------- tasks

export interface Task {
  id: string
  projectId: string | null
  projectName: string | null
  projectColor: string | null
  /** Falls back to the project's area when the task has none of its own. */
  areaId: string | null
  /** Derived from the project; a task without a project has no organization. */
  organizationId: string | null
  /** What kind of activity this is. Null means unlabelled, which is an honest answer. */
  workTypeId: string | null
  title: string
  priority: Priority
  status: TaskStatus
  /**
   * null means "not estimated yet" — never zero. The planner answers an unknown estimate
   * with a discovery block rather than by pretending the work takes no time.
   */
  estimateMin: number | null
  /** null means "no deadline" — never a fake far-future date. */
  dueDate: IsoDate | null
  /** Cannot sensibly be started before this date, e.g. data arrives Monday. */
  earliestStartDate: IsoDate | null
  /** Raised each time a planned block for this task is pushed to a later day. */
  postponedCount: number
  /** Free text when status is 'blocked': "waiting for supervisor", "waiting for data", … */
  blockedReason: string | null
  /** The user pinned this task to a specific day as a must-do. */
  mustDoDate: IsoDate | null
  /** What done means, what is needed, particulars — what Jarvis asked when it was made. */
  notes: string | null
  /** auto = the rule in domain/focus.ts; always / never override it for this task. */
  focusMode: FocusMode
  sortOrder: number
  createdAt: number
  completedAt: number | null
  /** Rolled up from time segments — never stored, always derived. */
  loggedMin: number
}

export interface NewTask {
  title: string
  projectId?: string | null
  areaId?: string | null
  workTypeId?: string | null
  priority?: Priority
  estimateMin?: number | null
  dueDate?: IsoDate | null
  earliestStartDate?: IsoDate | null
  notes?: string | null
  focusMode?: FocusMode
}

export type FocusMode = 'auto' | 'always' | 'never'

export type TaskPatch = Partial<
  Pick<
    Task,
    | 'title'
    | 'projectId'
    | 'areaId'
    | 'priority'
    | 'status'
    | 'estimateMin'
    | 'dueDate'
    | 'earliestStartDate'
    | 'workTypeId'
    | 'blockedReason'
    | 'mustDoDate'
    | 'notes'
    | 'focusMode'
    | 'sortOrder'
  >
>

/**
 * 'active' means everything still on your plate: open, in progress or blocked.
 *
 * Working on a task flips it to 'in_progress' automatically, so a filter of exactly
 * 'open' silently empties every list the moment you start tracking. Callers that mean
 * "not finished" must say `active`.
 */
export type TaskStatusFilter = TaskStatus | 'active'

export interface TaskFilter {
  status?: TaskStatusFilter
  projectId?: string
  areaId?: string
  priority?: Priority
  search?: string
}

// ------------------------------------------------------------ dependencies

/**
 * hard      — the dependent task cannot be scheduled or started at all
 * preferred — the planner puts the prerequisite first, but does not block
 */
export type DependencyType = 'hard' | 'preferred'

export interface TaskDependency {
  taskId: string
  dependsOnTaskId: string
  dependsOnTitle: string
  dependsOnStatus: TaskStatus
  type: DependencyType
}

/**
 * Where a task stands, once its dependencies are taken into account.
 *
 * `ready` is the one that matters: it is the answer to "what can I actually pick up now",
 * which neither the status field nor the due date can give on their own.
 */
export type TaskReadiness = 'done' | 'ready' | 'waiting' | 'blocked'

/** One task inside a project overview, with everything needed to place it in the order. */
export interface ProjectTaskRow {
  taskId: string
  title: string
  /** Position in dependency order, 1-based — the number shown against the row. */
  order: number
  readiness: TaskReadiness
  priority: Priority
  status: TaskStatus
  workTypeName: string | null
  dueDate: IsoDate | null
  estimateMin: number | null
  loggedMin: number
  /** Unfinished hard prerequisites, so a waiting row can say what it waits for. */
  waitingOn: Array<{ taskId: string; title: string; order: number }>
  /** What is waiting on this one — the cost of leaving it undone. */
  blocks: Array<{ taskId: string; title: string; order: number }>
  /** When it is actually scheduled, from accepted day plans. Null means unplanned. */
  plannedFrom: IsoDate | null
  plannedTo: IsoDate | null
  plannedMin: number
  blockedReason: string | null
}

/**
 * One project, in the order the work has to happen.
 *
 * Built to answer three questions in one screen: what is where, what can be started now,
 * and when each piece is due to happen.
 */
export interface ProjectOverview {
  project: Project
  areaName: string | null
  organizationName: string | null
  tasks: ProjectTaskRow[]
  taskCount: number
  doneCount: number
  estimateMin: number
  loggedMin: number
  /** Still to do, from the estimates that exist. */
  remainingMin: number
  /** The next thing that can actually be picked up. */
  nextTaskId: string | null
  /** The last deadline in the project — what "finished" means as a date. */
  finalDueDate: IsoDate | null
  /** Unfinished work that is already past its due date. */
  overdueCount: number
  /** Unfinished work with an estimate and no place in any accepted plan. */
  unplannedCount: number
}

/** Common reasons, offered as suggestions; the field itself takes any text. */
export const BLOCKED_REASONS = [
  'waiting for supervisor',
  'waiting for data',
  'waiting for approval'
] as const

// ---------------------------------------------------------------- sessions

export interface Session {
  id: string
  taskId: string | null
  taskTitle: string | null
  projectName: string | null
  startedAt: number
  /** null while running. */
  endedAt: number | null
  note: string | null
  /** True when the session was closed by the idle watchdog rather than by the user. */
  autoStopped: boolean
  /** Derived: minutes elapsed, or minutes so far if still running. */
  durationMin: number
}

export type SessionPatch = Partial<Pick<Session, 'taskId' | 'startedAt' | 'endedAt' | 'note'>>

// ---------------------------------------------------------------- planning

export interface PlannedBlock {
  id: string
  taskId: string
  taskTitle: string
  projectName: string | null
  projectColor: string | null
  date: IsoDate
  /** Minutes from local midnight. */
  startMin: number
  endMin: number
}

export interface NewPlannedBlock {
  taskId: string
  date: IsoDate
  startMin: number
  endMin: number
}

/** One row of the planned-vs-actual comparison. */
export interface PlannedVsActual {
  taskId: string
  taskTitle: string
  projectName: string | null
  /**
   * What the first accepted plan for these days said.
   *
   * Kept apart from `plannedMin` because replanning would otherwise erase the evidence:
   * a plan rewritten on Thursday afternoon always agrees with Thursday afternoon.
   */
  baselineMin: number
  plannedMin: number
  actualMin: number
  /** actual - planned, signed. */
  deltaMin: number
}

// ------------------------------------------------------------------- plans

export type PlanScope = 'day' | 'week'
export type PlanStatus = 'draft' | 'accepted' | 'superseded' | 'completed'
export type BlockKind = 'task' | 'meeting' | 'break' | 'buffer'
export type BlockSource = 'manual' | 'planner' | 'imported'
export type PlanIntensity = 'relaxed' | 'balanced' | 'full'

/** Buffer left unfilled, per intensity. Never plan 100% of a day. */
export const INTENSITY_BUFFER: Record<PlanIntensity, number> = {
  relaxed: 0.2,
  balanced: 0.12,
  full: 0.05
}

/**
 * A plan is a versioned document, not a mutable calendar.
 *
 * Revising a plan creates a new row pointing at the old one through parentPlanId. The
 * first accepted plan for a period is its baseline and stays reachable forever, which is
 * what lets a report say "planned 6h, replanned to 4h, actually worked 5h20".
 */
export interface Plan {
  id: string
  scope: PlanScope
  /** '2026-08-04' for a day plan, '2026-W32' for a week plan. */
  periodKey: string
  version: number
  parentPlanId: string | null
  status: PlanStatus
  /** Why this revision exists — shown in the plan history. */
  reason: string | null
  intensity: PlanIntensity
  createdAt: number
  acceptedAt: number | null
}

export interface PlanBlock {
  id: string
  planId: string
  taskId: string | null
  taskTitle: string | null
  areaId: string | null
  projectName: string | null
  projectColor: string | null
  date: IsoDate
  startMin: number
  endMin: number
  kind: BlockKind
  /** Used by meetings and breaks, which have no task. */
  title: string | null
  /** A real-world commitment: the planner may not move or overwrite it. */
  fixed: boolean
  /** The user pinned this block: replanning leaves it alone. */
  locked: boolean
  source: BlockSource
  /** Points at the block this one descends from, so a diff can say "moved" not "replaced". */
  originalBlockId: string | null
  /** Why the planner put this here, in plain language. */
  explanation: string | null
  score: number | null
}

export interface NewPlanBlock {
  taskId?: string | null
  areaId?: string | null
  date: IsoDate
  startMin: number
  endMin: number
  kind?: BlockKind
  title?: string | null
  fixed?: boolean
  locked?: boolean
  source?: BlockSource
  originalBlockId?: string | null
  explanation?: string | null
  score?: number | null
}

/**
 * A draft with work in it that nothing is reading.
 *
 * Every reader of a plan takes the accepted version of a period, so a draft counts toward
 * no total, appears in no grid and reaches no report. That is correct while you are still
 * editing it and quietly wrong once you have walked away, which is what this type exists to
 * surface.
 */
export interface PendingDraft {
  planId: string
  scope: PlanScope
  /** '2026-08-04' for a day plan, '2026-W32' for a week plan. */
  periodKey: string
  blockCount: number
  plannedMin: number
  /** True when accepting supersedes a plan already in force — a revision, not a first plan. */
  replacesAccepted: boolean
  createdAt: number
}

/** A plan together with its blocks — what a planning screen needs in one call. */
export interface DayPlan {
  date: IsoDate
  /** null when this day has never been planned. */
  plan: Plan | null
  blocks: PlanBlock[]
  /** Working window and area rules for this weekday. */
  availability: Availability | null
  events: FixedEvent[]
}

// -------------------------------------------------------- plan proposals

export type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'postponed'

export interface PlanChange {
  kind: 'add' | 'move' | 'resize' | 'remove'
  blockId: string | null
  taskTitle: string | null
  from: { date: IsoDate; startMin: number; endMin: number } | null
  to: { date: IsoDate; startMin: number; endMin: number } | null
  /** One sentence, written for a human. */
  explanation: string
}

export interface PlanUpdateProposal {
  id: string
  basePlanId: string
  proposedPlanId: string
  reason: string
  changes: PlanChange[]
  affectedDays: IsoDate[]
  deadlineRisks: string[]
  unscheduledMin: number
  status: ProposalStatus
  createdAt: number
  resolvedAt: number | null
}

// ---------------------------------------------------------- availability

export interface Availability {
  id: string
  /** null for the recurring default pattern; an ISO week key for a one-off override. */
  week: IsoWeek | null
  /** 1 = Monday … 7 = Sunday */
  weekday: number
  startMin: number
  endMin: number
  /** Area ids allowed on this day. Empty means all areas. */
  allowedAreas: string[]
  /**
   * The part of the day that belongs to the internship, in minutes since midnight.
   *
   * Deliberately *inside* the working window rather than equal to it. The window is when
   * you are willing to work at all — nine in the morning to ten at night in a busy
   * fortnight — and the internship is not entitled to all of it. Stage work is placed only
   * between these two minutes; school and personal work only outside them. Null on both
   * means the day has no internship hours at all, which is what a Saturday is.
   */
  stageStartMin: number | null
  stageEndMin: number | null
  /** Optional target minutes per area id, e.g. { stage: 390, work: 30 }. */
  areaTargets: Record<string, number>
  enabled: boolean
}

export type FixedEventKind = 'meeting' | 'break' | 'unavailable'

export interface FixedEvent {
  id: string
  date: IsoDate
  startMin: number
  endMin: number
  title: string
  kind: FixedEventKind
  areaId: string | null
  recurring: boolean
}

export interface PlanningProfile {
  id: string
  name: string
  bufferPercentage: number
  minimumBlockMin: number
  preferredBlockMin: number
  maximumBlockMin: number
  /** Given to a task whose estimate is unknown, to find out how long it really takes. */
  discoveryBlockMin: number
  isDefault: boolean
}

// ---------------------------------------------------------------- tracking

/**
 * One continuous stretch of working. A run survives task switching: switching closes the
 * current segment and opens the next at the same instant, leaving no gap in the run.
 */
export interface TrackingRun {
  id: string
  startedAt: number
  endedAt: number | null
  note: string | null
  segments: TimeSegment[]
  durationMin: number
}

export type CompletionReason = 'switched' | 'completed' | 'blocked' | 'break' | 'stopped' | 'idle'

export interface TimeSegment {
  id: string
  trackingRunId: string
  taskId: string | null
  taskTitle: string | null
  areaId: string | null
  areaName: string | null
  projectName: string | null
  planBlockId: string | null
  startedAt: number
  endedAt: number | null
  /**
   * Snapshot of the area's rule at the moment the work happened. Duplicated on purpose:
   * reclassifying an area later must not rewrite hours already reported.
   */
  countsAsStageHours: boolean
  note: string | null
  completionReason: CompletionReason | null
  autoStopped: boolean
  durationMin: number
  /**
   * How this segment got its task. 'tracked' means the task was chosen while the clock
   * ran, so its start and end are real; 'estimated' means it is a slice cut out of an
   * unattributed stretch from a percentage given afterwards, so the duration is meant
   * but the clock times are not. Nothing may present the two as equally precise.
   */
  attribution: Attribution
  /**
   * The id of the stretch this slice was cut from, or null for a segment that was never
   * split. Every slice of one stretch carries it, the anchor included.
   */
  attributionGroup: string | null
}

/**
 * Where a segment's minutes came from. See migration 015.
 *
 * The distinction is not bookkeeping: it decides what the end-of-day division is allowed to
 * touch. That step divides 'tracked' time and re-divides its own 'estimated' output, and it
 * must never reach a 'manual' stretch — hours you typed in by hand because you forgot to
 * track them are not a guess waiting to be revised, and having them silently re-divided by
 * tonight's percentages would be the worst kind of data loss.
 */
export type Attribution =
  /** Measured. The clock ran, and its start and end are real. */
  | 'tracked'
  /** A share of a measured stretch, named afterwards. Duration meant, clock times not. */
  | 'estimated'
  /** Entered by hand for time that was never tracked. Neither span nor share was measured. */
  | 'manual'

/** One task's share of a day's unattributed time, as the user gives it. */
export interface TaskShare {
  taskId: string
  /** 0-100. A day's shares need not reach 100; the rest stays unattributed. */
  sharePct: number
}

/** A task with minutes on a day, however those minutes got there. */
export interface AttributedTask {
  taskId: string
  taskTitle: string
  projectName: string | null
  areaName: string | null
  minutes: number
  countsAsStageHours: boolean
  attribution: Attribution
}

/**
 * What the end-of-day attribution step renders, and what it may change.
 *
 * Only `unattributedMin` is up for division. Time whose task was chosen while tracking is
 * a fact and is reported here purely so the sheet can say what share of the day the step
 * is actually about.
 */
export interface DayAttribution {
  date: IsoDate
  /** Minutes on segments that have no task. */
  unattributedMin: number
  /** Minutes on segments whose task was chosen while the clock ran. */
  trackedMin: number
  /** Minutes a previous run of this step already divided. */
  estimatedMin: number
  /** How the day stands now, tracked and estimated together, largest first. */
  tasks: AttributedTask[]
  /** The shares the last run used, so reopening the sheet restores them. */
  shares: TaskShare[]
}

/**
 * One stretch of time and what it went to, as the stretch editor reads and writes it.
 *
 * A stretch is the unit a person recognises — "Tuesday afternoon" — where a segment is the
 * unit the database stores. Dividing an afternoon over three tasks makes three segments out
 * of one stretch, and every gesture that follows (move it, resize it, re-divide it, delete
 * it) means the stretch, never one of its slices.
 */
export interface Stretch {
  /** The group id, which is also the id of the slice carrying the original row. */
  id: string
  date: IsoDate
  /** Minutes past midnight on `date`. */
  startMin: number
  /** Minutes past midnight. Less than or equal to `startMin` means the following morning. */
  endMin: number
  durationMin: number
  attribution: Attribution
  shares: TaskShare[]
  tasks: AttributedTask[]
  note: string | null
  /** True while the clock is still running on it, which forbids resizing. */
  running: boolean
}

/** Hours for a stretch that was never tracked. */
export interface NewStretch {
  date: IsoDate
  startMin: number
  endMin: number
  shares: TaskShare[]
  note?: string | null
}

/** Totals split the way a supervisor report needs them. */
export interface TrackedTotals {
  totalMin: number
  stageMin: number
  otherMin: number
  byArea: Record<string, number>
}

// ----------------------------------------------------------------- capture

export type CaptureQuality = 'compact' | 'sharp' | 'hd'

export interface CaptureProfile {
  id: CaptureQuality
  label: string
  /** A ceiling, never an enlargement — frames are not scaled above the screen's own size. */
  maxWidth: number
  jpegQuality: number
  /** Measured, not guessed. See CAPTURE_PROFILES. */
  kbPerFrame: number
}

/**
 * The three capture qualities, with sizes taken from real JPEGs of a 1920×1080 screen
 * showing a dark code editor — which compresses well. A browser, a map or a photo runs
 * roughly half again as large, which is why `estimateStorage` reports a range rather than
 * a single figure that would only be true for one kind of work.
 *
 * This lives in the contract because both sides need it: the main process to encode, and
 * the settings screen to say what a choice costs before you make it.
 */
export const CAPTURE_PROFILES: Record<CaptureQuality, CaptureProfile> = {
  compact: {
    id: 'compact',
    label: 'Compact — 1280 px',
    maxWidth: 1280,
    jpegQuality: 70,
    kbPerFrame: 46
  },
  sharp: { id: 'sharp', label: 'Sharp — 1600 px', maxWidth: 1600, jpegQuality: 80, kbPerFrame: 77 },
  hd: { id: 'hd', label: 'Full HD — 1920 px', maxWidth: 1920, jpegQuality: 80, kbPerFrame: 106 }
}

/** Settings are merged from stored JSON, so an unknown value has to land somewhere sane. */
export const captureProfile = (quality: CaptureQuality): CaptureProfile =>
  CAPTURE_PROFILES[quality] ?? CAPTURE_PROFILES.hd

export interface StorageEstimate {
  framesPerDay: number
  mbPerDayLow: number
  mbPerDayHigh: number
  mbRetainedHigh: number
}

/**
 * What a capture setting costs on disk.
 *
 * `mbRetainedHigh` is the number that matters: frames expire after the retention window, so
 * the footprint stops growing there instead of climbing all internship long.
 */
export function estimateStorage(
  quality: CaptureQuality,
  intervalMin: number,
  workHoursPerDay = 8,
  retentionDays = 14
): StorageEstimate {
  const framesPerDay = Math.round((workHoursPerDay * 60) / Math.max(1, intervalMin))
  const low = (framesPerDay * captureProfile(quality).kbPerFrame) / 1024
  return {
    framesPerDay,
    mbPerDayLow: Math.round(low),
    mbPerDayHigh: Math.round(low * 1.5),
    mbRetainedHigh: Math.round(low * 1.5 * retentionDays)
  }
}

// --------------------------------------------------------------- artifacts

export interface Artifact {
  id: string
  /** Pre-rework link. Null for anything captured since tracking moved to segments. */
  sessionId: string | null
  /** What you were working on when the frame was taken. Null for a manual grab while idle. */
  timeSegmentId: string | null
  day: IsoDate
  kind: ArtifactKind
  /** Absolute path on this machine. Never leaves the machine except inside a report. */
  path: string
  capturedAt: number
  /** The report approval gate. Only true artifacts reach the .docx. */
  included: boolean
  /** Resolved for display; not stored. */
  taskTitle?: string | null
}

// ------------------------------------------------------------------- stats

export interface DayStats {
  date: IsoDate
  trackedMin: number
  goalMin: number
  sessionCount: number
  /** Uninterrupted stretches of >= 25 tracked minutes. */
  focusBlocks: number
}

export interface WeekStats {
  week: IsoWeek
  plannedMin: number
  trackedMin: number
  goalMin: number
  focusBlocks: number
}

/** A tracked stretch on the Today timeline. */
export interface TimelineSegment {
  sessionId: string
  taskTitle: string | null
  startedAt: number
  endedAt: number
  durationMin: number
  /** 'estimated' slices have a real duration but invented clock times. See migration 015. */
  attribution: Attribution
  /** Slices of one stretch share this, so the timeline can draw them as the one bar they were. */
  attributionGroup: string | null
}

// ------------------------------------------------------- end-of-day review

/**
 * What the end-of-day wizard is allowed to publish.
 *
 * Every flag defaults to false. Publishing is opt-in per day; last week's choice never
 * carries over silently into today.
 */
export interface PublishFlags {
  sessions: boolean
  tasks: boolean
  summary: boolean
  screenshots: boolean
  timelapse: boolean
}

export const NO_PUBLISH: PublishFlags = {
  sessions: false,
  tasks: false,
  summary: false,
  screenshots: false,
  timelapse: false
}

export interface DayReport {
  date: IsoDate
  summary: string
  flags: PublishFlags
  reviewedAt: number | null
  /** The consent stamp. Null means nothing about this day is visible to anyone else. */
  publishedAt: number | null
}

/** One row of the wizard's "Top activities" list. */
export interface Activity {
  taskId: string | null
  taskTitle: string
  projectName: string | null
  priority: Priority | null
  minutes: number
}

/** The numbers shown in step 1 of the end-of-day wizard. */
export interface DayReview {
  date: IsoDate
  trackedMin: number
  /** Time inside sessions long enough to count as focus. Subset of trackedMin. */
  focusMin: number
  /** Gaps between sessions, within the working window. Not counted as tracked. */
  breakMin: number
  sessionCount: number
  /** Tracked minutes with no task on them. The attribution step exists for these. */
  unattributedMin: number
  completedTasks: number
  totalTasks: number
  topActivities: Activity[]
  screenshotCount: number
  includedScreenshotCount: number
  hasTimelapse: boolean
}

// ----------------------------------------------------------------- reports

export interface ReportTaskRow {
  taskTitle: string
  projectName: string | null
  /** The original plan, before any replanning. See PlannedVsActual. */
  baselineMin: number
  plannedMin: number
  actualMin: number
  status: TaskStatus
}

export interface WeekReport {
  week: IsoWeek
  /** Monday and Sunday of the week, local dates. */
  from: IsoDate
  to: IsoDate
  generatedAt: number
  rows: ReportTaskRow[]
  totalPlannedMin: number
  totalTrackedMin: number
  completedTasks: number
  totalTasks: number
  /** Screenshots of this week, with their include flags — the approval grid. */
  screenshots: Artifact[]
  timelapse: Artifact | null
  /** Free-text summary for the supervisor, Dutch, max 1000 chars. */
  summary: string
  /** Blocks planned for the week after this one. */
  nextWeekPlanning: PlannedBlock[]
  docxPath: string | null
  sentAt: number | null
}

// --------------------------------------------------------------- calendars

/** 'ics' is a subscribed link: read-only, and the only route that needs no permission. */
export type CalendarProviderId = 'outlook' | 'icloud' | 'ics'
/**
 * How an account proves who it is. A property of the account, not of the provider — the
 * same provider can support several, and which one is in use changes over time.
 */
export type CalendarAuthMethod = 'oauth' | 'app-password' | 'url'
export type CalendarAccountStatus = 'connected' | 'disconnected' | 'error'

export interface CalendarAccount {
  id: string
  provider: CalendarProviderId
  authMethod: CalendarAuthMethod
  displayName: string
  accountIdentifier: string | null
  status: CalendarAccountStatus
  lastSyncAt: number | null
  lastError: string | null
}

/**
 * One calendar inside an account.
 *
 * The defaults are what stop the classification popup becoming a chore: a calendar that is
 * only ever school work can say so once, and its events arrive classified.
 */
export interface CalendarSource {
  id: string
  accountId: string
  externalId: string
  name: string
  color: string | null
  selected: boolean
  writable: boolean
  defaultAreaId: string | null
  defaultOrganizationId: string | null
  defaultProjectId: string | null
  defaultWorkTypeId: string | null
  /** Birthdays and holidays: shown if you like, never treated as busy time. */
  ignoreForPlanning: boolean
}

export type CalendarEventKind = 'appointment' | 'travel'
export type TravelDirection = 'outbound' | 'return'
export type CalendarOrigin = 'uurwerk' | 'outlook' | 'icloud' | 'ics'
export type ClassificationStatus = 'unclassified' | 'suggested' | 'confirmed' | 'ignored'

/**
 * How an event's time counts as worked time.
 *
 * Separate from tracking on purpose: the calendar says an hour was scheduled, the timer says
 * fifty-five minutes happened, and those are two pieces of evidence about one activity. They
 * are reconciled, never added.
 */
export type RegistrationMode = 'none' | 'calendar' | 'confirm'

export interface CalendarEvent {
  id: string
  title: string
  description: string | null
  location: string | null
  startsAt: number
  endsAt: number
  allDay: boolean

  kind: CalendarEventKind
  /** Set on a travel block: the appointment it belongs to. */
  parentEventId: string | null
  travelDirection: TravelDirection | null
  /** Once you move a travel block yourself, the parent stops dragging it around. */
  travelDetached: boolean

  recurrenceRule: string | null
  recurrenceMasterId: string | null
  originalStartsAt: number | null
  cancelled: boolean

  organizer: string | null
  attendees: string[]
  origin: CalendarOrigin

  areaId: string | null
  organizationId: string | null
  projectId: string | null
  workTypeId: string | null
  classificationStatus: ClassificationStatus
  /** 0–100 from the local classifier; only meaningful while 'suggested'. */
  confidence: number | null

  includeInPlanning: boolean
  registrationMode: RegistrationMode
  countsAsWorked: boolean
  confirmedMin: number | null
  reconciledSegmentId: string | null

  localUpdatedAt: number
  deletedAt: number | null
}

export interface NewCalendarEvent {
  title: string
  description?: string | null
  location?: string | null
  startsAt: number
  endsAt: number
  allDay?: boolean
  kind?: CalendarEventKind
  parentEventId?: string | null
  travelDirection?: TravelDirection | null
  recurrenceRule?: string | null
  recurrenceMasterId?: string | null
  originalStartsAt?: number | null
  organizer?: string | null
  attendees?: string[]
  origin?: CalendarOrigin
  areaId?: string | null
  organizationId?: string | null
  projectId?: string | null
  workTypeId?: string | null
  classificationStatus?: ClassificationStatus
  confidence?: number | null
  includeInPlanning?: boolean
  registrationMode?: RegistrationMode
  countsAsWorked?: boolean
}

export type SyncStatus =
  | 'synced'
  | 'local_changed'
  | 'external_changed'
  | 'conflict'
  | 'deleted'

/** The same logical event as one provider knows it. */
export interface CalendarEventLink {
  id: string
  eventId: string
  accountId: string
  calendarId: string | null
  externalId: string
  etag: string | null
  externalUpdatedAt: number | null
  lastSyncedAt: number | null
  syncStatus: SyncStatus
}

export type RuleMatcher = 'title' | 'location' | 'attendee' | 'organizer' | 'calendar'

/** Something Uurwerk learned from a choice you made. Local, inspectable, deletable. */
export interface ClassificationRule {
  id: string
  matcher: RuleMatcher
  pattern: string
  areaId: string | null
  organizationId: string | null
  projectId: string | null
  workTypeId: string | null
  hits: number
  source: 'user' | 'derived'
  lastUsedAt: number | null
}

/** What the classifier thinks, and why — the "86% match" card. */
export interface ClassificationSuggestion {
  areaId: string | null
  organizationId: string | null
  projectId: string | null
  workTypeId: string | null
  /** 0–100. */
  confidence: number
  /** Plain sentences: what matched, so the guess can be argued with. */
  reasons: string[]
}

/** Travel around an appointment, in minutes. Entered by hand; no route lookup. */
export interface TravelPlan {
  outboundMin: number
  returnMin: number
  /** Whether the journey counts toward worked hours. */
  countsAsWorked: boolean
}

// ------------------------------------------------------------ commitments

/**
 * Hours that are already spoken for, every week — a shift, a class, a standing appointment.
 *
 * A rule rather than a pile of dated rows, so "Tuesday evenings at Jumbo" is one thing you
 * can change or end. It is expanded into dated occurrences when a range is planned, and a
 * one-off event on a specific day still overrides it.
 */
export interface RecurringCommitment {
  id: string
  title: string
  /** 1 = Monday .. 7 = Sunday. */
  weekday: number
  startMin: number
  endMin: number
  kind: FixedEventKind
  /** What the time counts as, if anything. A shift is usually Work. */
  areaId: string | null
  /** Who it is for — what keeps one employer's shifts apart from another's. */
  organizationId: string | null
  activeFrom: IsoDate
  /** Null means "until further notice". */
  activeTo: IsoDate | null
  archived: boolean
}

export interface NewRecurringCommitment {
  title: string
  weekday: number
  startMin: number
  endMin: number
  kind?: FixedEventKind
  areaId?: string | null
  organizationId?: string | null
  activeFrom?: IsoDate
  activeTo?: IsoDate | null
}

/**
 * Work that cannot be finished by its due date, and the two honest ways out.
 *
 * Either hours appear that are not there now — the same amount every remaining day is the
 * simplest way to say how many — or the date moves to one the work can actually be done by.
 * The app presents both and picks neither.
 */
export interface Shortfall {
  taskId: string
  taskTitle: string
  dueDate: IsoDate
  requiredMin: number
  availableMin: number
  shortfallMin: number
  /** Null when it does not fit inside the planned range at all. */
  earliestFinishDate: IsoDate | null
  extraMinPerDay: number
  daysBeforeDue: number
}

// -------------------------------------------------------------- statistics

/**
 * Tracked time sliced three ways, filtered independently.
 *
 * These live in the contract rather than beside the service because the Statistics screen
 * renders them, and the renderer may only import from here — the seam is what lets the same
 * components run against a different backend later.
 */
export interface BreakdownFilter {
  /** Empty or absent means "every area" — never "no areas". */
  areaIds?: string[]
  organizationIds?: string[]
  workTypeIds?: string[]
}

export interface Breakdown {
  totalMin: number
  /** Only segments whose own stored rule says they count toward the internship. */
  stageMin: number
  byArea: Record<string, number>
  byOrganization: Record<string, number>
  byWorkType: Record<string, number>
  /** Both dimensions at once: `${areaId}::${organizationId}`. */
  byAreaAndOrganization: Record<string, number>
}

export type RangePreset = 'week' | '4weeks' | '3months' | 'custom'

export interface RangeRequest {
  preset: RangePreset
  /** Only for 'custom'; ignored otherwise. */
  from?: IsoDate
  to?: IsoDate
}

/** One column of the chart: a day when the range is a week, otherwise a week. */
export interface Bucket {
  key: string
  label: string
  sublabel: string
  /** Minutes per area id. An area with no time is absent rather than zero. */
  byArea: Record<string, number>
  trackedMin: number
  screenTimeMin: number
}

export interface Metric {
  min: number
  /** The same figure for the period immediately before, for the delta. */
  previousMin: number
}

export interface AreaShare {
  areaId: string
  name: string
  color: string
  minutes: number
  /** Share of tracked time in the range, 0–1. */
  fraction: number
}

export interface ProjectShare {
  projectId: string | null
  name: string
  minutes: number
  countsAsStageHours: boolean
}

export interface WorkTypeComparison {
  workTypeId: string | null
  name: string
  plannedMin: number
  actualMin: number
}

export interface DataQuality {
  /** 0–1: what share of the checks below came back clean. */
  score: number
  segmentsWithoutTask: number
  tasksWithoutEstimate: number
  openTrackingRuns: number
  categorisedFraction: number
}

export interface Insight {
  kind: 'overplanned-weekday' | 'blocked-unlocks' | 'unplanned-share'
  text: string
}

export interface StatisticsOverview {
  from: IsoDate
  to: IsoDate
  preset: RangePreset
  /** True when the buckets are days; the chart labels differ. */
  daily: boolean
  buckets: Bucket[]
  tracked: Metric
  stage: Metric
  planned: Metric
  screenTime: Metric
  /** Tracked against planned. Null when nothing was planned — that is not "0% done". */
  planCompletion: number | null
  previousPlanCompletion: number | null
  tasksCompleted: Metric
  /** False until anything has been recorded, so a zero can be read as "not measured". */
  hasScreenTime: boolean
  areas: AreaShare[]
  projects: ProjectShare[]
  workTypes: WorkTypeComparison[]
  quality: DataQuality
  insights: Insight[]
}

// ---------------------------------------------------------------- snapshot

/**
 * The ONLY payload that ever leaves this machine over the network.
 * Text and numbers. No paths, no images, no notes.
 */
/**
 * One published day, as the supervisor's page receives it.
 *
 * Every section is optional and absent by default: a field that is missing was not
 * approved, and there is no shape of this object that says "nothing selected but here are
 * the numbers anyway". Image *paths* never appear — only the random remote names of files
 * that were uploaded alongside it.
 */
/**
 * Who a published day is for.
 *
 * Two audiences, and deliberately two consents: the supervisor at the internship and the
 * teacher at school are different people with different reasons to be looking. A day is
 * prepared once per audience and lands in its own index, so neither can be handed the
 * other's view by accident.
 */
export type PublishAudience = 'supervisor' | 'teacher'

export interface PublishedDay {
  date: IsoDate
  publishedAt: number
  /** Present only when the sessions flag is on. Stage hours only. */
  trackedMin?: number
  focusMin?: number
  sessionCount?: number
  /** Present only when the tasks flag is on. */
  completedTasks?: number
  totalTasks?: number
  activities?: Array<{ title: string; minutes: number }>
  /** Present only when the summary flag is on and something was written. */
  summary?: string
  /** Random remote names, never local paths. */
  screenshots?: string[]
  timelapse?: string
}

/** The entry point of the published site: which days exist, and where each one lives. */
export interface PublishIndex {
  updatedAt: number
  days: Array<{ date: IsoDate; payload: string }>
}

export interface PublicSnapshot {
  updatedAt: number
  /** True only while internship time is being tracked; private work reads as idle. */
  tracking: boolean
  currentTask: string | null
  currentProject: string | null
  /**
   * Stage hours only, deliberately. Time in Work or Personal is not reported at all — not
   * even as a total, because a total is enough to tell someone how your evening went.
   */
  todayStageMin: number
  weekStageMin: number
  weekPlannedMin: number
  weekGoalMin: number
  /** Counted over tasks the supervisor is allowed to see; the rest are not even totalled. */
  openTasks: number
  completedThisWeek: number
}

// ---------------------------------------------------------------- settings

export interface Hotkeys {
  startStop: string
  quickAdd: string
  toggleWindow: string
  markScreenshot: string
  endOfDay: string
}

export interface Settings {
  hotkeys: Hotkeys
  dailyGoalMin: number
  weeklyGoalMin: number
  /**
   * The area a new task lands in when nothing else says otherwise.
   *
   * Without this, tasks created from the quick-add window or the switcher would have no
   * area at all — and an area-less task never counts toward internship hours, silently.
   */
  defaultAreaId: string
  /** Minutes between automatic screenshots while the timer runs. */
  captureIntervalMin: number
  captureEnabled: boolean
  /** Resolution and JPEG quality of a frame. See CAPTURE_PROFILES for the measured sizes. */
  captureQuality: CaptureQuality
  /** Idle minutes after which the timer pauses and capture stops. */
  idleTimeoutMin: number
  /**
   * Start the timer again on the same task when you come back from an idle pause.
   *
   * Counts from the moment you return, never from when you left, and only ever after an
   * idle stop — stopping the timer yourself is a decision the app does not overrule.
   */
  resumeAfterIdle: boolean
  /** Window-title substrings that pause capture. Case-insensitive. */
  captureBlocklist: string[]
  /** Frames per second in the generated timelapse. 8 turns a working day into ~12 seconds. */
  timelapseFps: number
  reportOutputDir: string
  supervisorEmail: string
  /** Only used to address the covering e-mail; blank falls back to a neutral greeting. */
  supervisorName: string
  /** 'draft' opens the mail client; 'smtp' sends directly. */
  mailMode: 'draft' | 'smtp'
  smtpHost: string
  smtpPort: number
  smtpUser: string
  publishEnabled: boolean
  publishUrl: string

  // ------------------------------------------------------ incoming events
  /**
   * How much Uurwerk decides for itself about new calendar events.
   *
   * 'ask-when-uncertain' is the default because both extremes are bad: a popup for every
   * appointment gets dismissed on reflex, and silent classification quietly files hours
   * under the wrong project.
   */
  calendarClassification: 'automatic' | 'ask-when-uncertain' | 'always-ask' | 'never'
  /** Confidence below which it asks rather than deciding. */
  calendarAskBelow: number
  /** Refresh subscribed calendars on their own, rather than only when asked. */
  calendarAutoSync: boolean
  /** Minutes between refreshes. A published calendar is regenerated slowly anyway. */
  calendarSyncEveryMin: number
  /** Turn corrections into rules, so the same weekly meeting stops asking. */
  calendarLearn: boolean
  /** Say so when something was classified without asking, so it can be corrected. */
  calendarNotifyOnAuto: boolean

  // ------------------------------------------------------- Windows startup
  /** Start Uurwerk when signing in to Windows. Only applied in a packaged build. */
  autoLaunch: boolean
  /** What launching does: sit in the tray, open the dashboard, or offer to plan the day. */
  startupBehaviour: 'tray' | 'dashboard' | 'morningPlanner'
  showMorningNotification: boolean
  /** Keep running in the tray when the window is closed. */
  closeToTray: boolean

  // ------------------------------------------------------------------ sync
  /**
   * The VPS this copy syncs with, e.g. https://uurwerk.duckdns.org. Empty = this copy stands
   * alone, the way the app worked before there was a server. Per device, never synced.
   */
  serverUrl: string

  // ----------------------------------------------------------------- focus
  /** Phone: turn the "Uurwerk" Focus on and off through two Shortcuts. Per device. */
  focusShortcuts: boolean
  /** Laptop: programs closed while a focus task is running, by process name. Per device. */
  focusBlockedApps: string[]
}
