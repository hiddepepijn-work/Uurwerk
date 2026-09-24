/**
 * ★ THE SEAM ★
 *
 * This interface is the single boundary between the frontend and everything behind it.
 *
 *   packages/main/src/ipc.ts        implements it over Electron IPC   (the desktop app)
 *   packages/renderer/src/api/mock  implements it in memory           (UI development)
 *   publish/api/http-client.ts      implements a read-only subset     (supervisor view)
 *
 * The React components never know which one they are talking to. That is what makes the
 * supervisor's web view a bolt-on instead of a rewrite — so keep this interface
 * transport-agnostic: no Electron types, no file handles, no Node streams. Plain data only.
 */

import type {
  Area,
  Breakdown,
  BreakdownFilter,
  CalendarAccount,
  CalendarEvent,
  CalendarSource,
  ClassificationRule,
  ClassificationSuggestion,
  NewCalendarEvent,
  RangeRequest,
  RegistrationMode,
  StatisticsOverview,
  TravelPlan,
  Artifact,
  ArtifactKind,
  Availability,
  DayPlan,
  DayReport,
  DayAttribution,
  DayReview,
  DayStats,
  DependencyType,
  FixedEvent,
  IsoDate,
  IsoWeek,
  NewArea,
  NewOrganization,
  NewPlanBlock,
  NewProject,
  NewRecurringCommitment,
  NewStretch,
  NewTask,
  NewWorkType,
  Organization,
  PendingDraft,
  RecurringCommitment,
  Shortfall,
  Plan,
  PlanBlock,
  PlanIntensity,
  PlannedBlock,
  PlannedVsActual,
  Project,
  ProjectOverview,
  PublicSnapshot,
  PublishFlags,
  Settings,
  Stretch,
  Task,
  TaskDependency,
  TaskFilter,
  TaskPatch,
  TaskShare,
  TimelineSegment,
  TimeSegment,
  TrackedTotals,
  TrackingRun,
  WeekReport,
  WeekStats,
  WorkType
} from './types.js'

export interface ProposeRequest {
  intensity?: PlanIntensity
  /** Plan only from this minute of the day onward. */
  fromMin?: number
}

/**
 * What `reports.send` did.
 *
 * `sent` is false in draft mode even when everything worked, because the message is sitting
 * in a mail client waiting for you — and an app that says "sent" when it means "opened" is
 * how a supervisor ends up never receiving a week.
 */
export interface SendOutcome {
  mode: 'draft' | 'smtp'
  sent: boolean
  /** Shown to the user verbatim: what happened, and what is still theirs to do. */
  message: string
}

/** What one refresh did. Shown after a manual sync so it is never a silent no-op. */
export interface CalendarSyncResult {
  accountId: string
  accountName: string
  imported: number
  updated: number
  cancelled: number
  /** Confident enough to file without asking. */
  autoClassified: number
  /** Now waiting for a decision. */
  pending: number
  error: string | null
}

/**
 * What one push to the phone did.
 *
 * Four numbers rather than a boolean, because "nothing changed" and "wrote nothing because
 * it failed quietly" have to be distinguishable at a glance.
 */
export interface PlanPushResult {
  calendarName: string
  created: number
  updated: number
  removed: number
  unchanged: number
}

/** An event waiting on a decision, with the guess and whether it should interrupt you. */
export interface PendingClassificationDto {
  event: CalendarEvent
  suggestion: ClassificationSuggestion
  /** 'classify' applies silently, 'suggest' pre-fills the popup, 'ask' opens it blank. */
  action: 'classify' | 'suggest' | 'ask'
}

/** What the classification popup sends back. */
export interface ClassificationChoiceDto {
  areaId: string | null
  organizationId: string | null
  projectId: string | null
  workTypeId: string | null
  /** Write rules so events like this stop asking. */
  remember: boolean
  includeInPlanning: boolean
  registrationMode: RegistrationMode
  countsAsWorked: boolean
  /** Omitted when there is no journey. */
  travel?: TravelPlan
}

/**
 * A range proposal, flattened for the bridge.
 *
 * `shortfalls` is the part that matters: it is empty when everything fits, and when it is
 * not, each entry carries both ways out rather than a bare failure.
 */
export interface RangeProposalDto {
  from: IsoDate
  to: IsoDate
  blocks: Array<NewPlanBlock & { score: number; explanation: string }>
  shortfalls: Shortfall[]
  unplaced: Array<{ taskId: string; taskTitle: string; minutes: number; reason: string }>
  plannedMin: number
  availableMin: number
  /** Days the proposal touches, so the caller can accept exactly those. */
  days: IsoDate[]
}

/** A proposal, flattened to plain data for the bridge. */
export interface DayProposalDto {
  date: IsoDate
  blocks: Array<NewPlanBlock & { score: number; explanation: string }>
  unplaced: Array<{ taskId: string; taskTitle: string; reason: string; minutes: number }>
  excluded: Array<{ taskId: string; taskTitle: string; reason: string; explanation: string }>
  ranked: Array<{ taskId: string; taskTitle: string; score: number; reasons: string[]; atRisk: boolean }>
  plannedMin: number
  bufferMin: number
  availableMin: number
}

/** What a task switch produced, plus whether it left internship hours behind. */
export interface SwitchOutcome {
  segment: TimeSegment
  /**
   * True when the new task's area does not count toward stage hours while the previous
   * one did. The UI confirms this with the user rather than letting it pass silently.
   */
  leavesStageHours: boolean
}

export type SegmentPatch = Partial<
  Pick<TimeSegment, 'taskId' | 'areaId' | 'startedAt' | 'endedAt' | 'note'>
>

export interface TimeTrackerAPI {
  /** The category above projects; carries the hour and sharing rules. */
  areas: {
    list(includeArchived?: boolean): Promise<Area[]>
    create(area: NewArea): Promise<Area>
    update(id: string, patch: Partial<Area>): Promise<Area>
    archive(id: string): Promise<void>
  }

  /**
   * Who work is for.
   *
   * Separate from `areas` on purpose, and never a substitute for one: the same organization
   * can host internship work and work that is not, so nothing may read a classification out
   * of an organization.
   */
  organizations: {
    list(includeArchived?: boolean): Promise<Organization[]>
    create(organization: NewOrganization): Promise<Organization>
    update(id: string, patch: Partial<Organization>): Promise<Organization>
    archive(id: string): Promise<void>
  }

  /** What the activity is — research, development, … — across every area. */
  workTypes: {
    list(includeArchived?: boolean): Promise<WorkType[]>
    create(workType: NewWorkType): Promise<WorkType>
    archive(id: string): Promise<void>
  }

  /**
   * Tracked time sliced by area, organization and work type, filtered independently.
   *
   * `stats` answers how much you worked; this answers how much of it was what, and for
   * whom. Passing no filter means everything — an empty list is never "match nothing".
   */
  breakdown: {
    day(date: IsoDate, filter?: BreakdownFilter): Promise<Breakdown>
    week(week: IsoWeek, filter?: BreakdownFilter): Promise<Breakdown>
    range(startMs: number, endMs: number, filter?: BreakdownFilter): Promise<Breakdown>
  }

  /**
   * Dividing a day's untasked time over the tasks it went to, given afterwards.
   *
   * The counterpart to starting the timer without picking anything: START records that you
   * are working, this records what the work was. It only ever touches segments with no task
   * on them — time whose task was chosen while the clock ran is left exactly as measured.
   */
  attribution: {
    day(date: IsoDate): Promise<DayAttribution>
    /** Replaces the day's division. Shares need not reach 100; the rest stays untasked. */
    apply(date: IsoDate, shares: TaskShare[]): Promise<DayAttribution>
    revert(date: IsoDate): Promise<DayAttribution>

    /** One stretch, by its group id or the id of any slice in it. */
    stretch(id: string): Promise<Stretch | null>
    /**
     * Hours for a stretch that was never tracked.
     *
     * Refuses a span that overlaps time already recorded: two entries over the same hour
     * both look reasonable alone and inflate every total downstream together.
     */
    addStretch(input: NewStretch): Promise<Stretch>
    /** Moves, resizes and re-divides one stretch. The rest of the day is untouched. */
    updateStretch(id: string, input: NewStretch): Promise<Stretch>
    removeStretch(id: string): Promise<void>
  }

  /** Everything the Statistics screen draws, for one range and one set of filters. */
  statistics: {
    overview(range: RangeRequest, filter?: BreakdownFilter): Promise<StatisticsOverview>
  }

  projects: {
    list(): Promise<Project[]>
    create(project: NewProject): Promise<Project>
    update(id: string, patch: Partial<Project>): Promise<Project>
    /** Flips whether this project is visible in the online supervisor view. */
    setShareable(id: string, shareable: boolean): Promise<void>
    /**
     * One project in the order the work has to happen.
     *
     * The task list sorts by priority, which cannot express that seven of eight chapters
     * are unstartable. This does: dependency order, what each row waits on, and when it is
     * scheduled in the accepted plans.
     */
    overview(projectId: string): Promise<ProjectOverview>
  }

  tasks: {
    list(filter?: TaskFilter): Promise<Task[]>
    get(id: string): Promise<Task | null>
    create(task: NewTask): Promise<Task>
    update(id: string, patch: TaskPatch): Promise<Task>
    complete(id: string, done: boolean): Promise<Task>
    remove(id: string): Promise<void>
  }

  /**
   * What has to happen before what.
   *
   * A hard dependency stops a task being scheduled at all until its prerequisite is done;
   * a preferred one is only an ordering hint. Cycles are rejected at write time, because a
   * cycle is the one shape that makes the planner unable to answer.
   */
  dependencies: {
    /** Every edge in one call — the task list needs it to show what is waiting on what. */
    list(): Promise<TaskDependency[]>
    forTask(taskId: string): Promise<TaskDependency[]>
    /** Replaces the whole set for one task, atomically. Throws on a cycle. */
    set(
      taskId: string,
      dependencies: Array<{ dependsOnTaskId: string; type: DependencyType }>
    ): Promise<TaskDependency[]>
    remove(taskId: string, dependsOnTaskId: string): Promise<void>
  }

  /**
   * The tracking model: one run, many segments.
   *
   * This replaced a `timer` domain that spoke in single-task sessions. That surface is
   * gone rather than deprecated: it read the pre-planner `sessions` table, which nothing
   * writes any more, so it could only ever answer with an empty list.
   */
  tracking: {
    startRun(taskId: string | null): Promise<TimeSegment>
    stopRun(note?: string): Promise<TimeSegment | null>
    /** Closes the current segment and opens the next at the same instant. */
    switchTask(taskId: string | null): Promise<SwitchOutcome>
    completeAndSwitch(nextTaskId: string | null): Promise<SwitchOutcome>
    blockAndSwitch(reason: string, nextTaskId: string | null): Promise<SwitchOutcome>
    currentRun(): Promise<TrackingRun | null>
    currentSegment(): Promise<TimeSegment | null>
    segmentsByDay(date: IsoDate): Promise<TimeSegment[]>
    segmentsByWeek(week: IsoWeek): Promise<TimeSegment[]>
    /** Tracked minutes split into stage hours and everything else. */
    totals(week: IsoWeek): Promise<TrackedTotals>
    updateSegment(id: string, patch: SegmentPatch): Promise<TimeSegment>
    removeSegment(id: string): Promise<void>
  }

  /**
   * Reading the week's plan. Editing it happens through `plans`, on a draft — the
   * schedule/move/unschedule methods that used to live here wrote to the flat `planned`
   * table that the versioned model replaced.
   */
  planning: {
    week(week: IsoWeek): Promise<PlannedBlock[]>
    /** Tasks with no planned block in this week — the right-hand panel. */
    unscheduled(week: IsoWeek): Promise<Task[]>
    plannedVsActual(week: IsoWeek): Promise<PlannedVsActual[]>
  }

  stats: {
    day(date: IsoDate): Promise<DayStats>
    week(week: IsoWeek): Promise<WeekStats>
    timeline(date: IsoDate): Promise<TimelineSegment[]>
  }

  /** The end-of-day wizard. */
  days: {
    review(date: IsoDate): Promise<DayReview>
    get(date: IsoDate): Promise<DayReport>
    saveSummary(date: IsoDate, summary: string): Promise<DayReport>
    saveFlags(date: IsoDate, flags: PublishFlags): Promise<DayReport>
    /** Stamps consent and uploads exactly what the flags and approvals allow. */
    publish(date: IsoDate): Promise<DayReport>
    /** Revokes consent and deletes the remote copies. */
    unpublish(date: IsoDate): Promise<DayReport>
  }

  /**
   * Day and week plans.
   *
   * Editing never touches an accepted plan: `draft` returns a working copy, the edits
   * land there, and `accept` promotes it and supersedes the previous version. That is
   * what keeps the baseline intact for reporting.
   */
  plans: {
    /** The accepted plan for a date, or null if the day was never planned. */
    day(date: IsoDate): Promise<DayPlan>
    /** Every accepted block across a week, for the week view. */
    week(week: IsoWeek): Promise<PlanBlock[]>
    /** Opens (or reopens) a draft for a date, copying the accepted blocks into it. */
    draft(date: IsoDate): Promise<DayPlan>
    /**
     * Drafts with work in them that nothing is reading yet.
     *
     * A draft is invisible to every total, grid and report until it is accepted, so one left
     * behind is planning that silently counts for nothing. This is how the UI can say so.
     */
    pending(): Promise<PendingDraft[]>
    accept(planId: string): Promise<Plan>
    /** Accepts several at once, in one transaction. Returns how many were promoted. */
    acceptMany(planIds: string[]): Promise<number>
    /**
     * Throws several drafts away at once. Returns how many were deleted.
     *
     * Drafts only — an accepted plan is history and is kept. Tracked hours are never taken
     * with them: a segment recorded against a discarded block is unlinked, not deleted.
     */
    discardMany(planIds: string[]): Promise<number>
    /**
     * Leaves a day with no plan at all.
     *
     * Not the same as discarding a draft, which only throws away the working copy and leaves
     * the plan it branched from still in force. This is what "I do not want this day planned"
     * means. The baseline survives, so the report can still show the original intention.
     */
    clearDay(date: IsoDate): Promise<void>
    discard(planId: string): Promise<void>
    addBlock(planId: string, block: NewPlanBlock): Promise<PlanBlock>
    updateBlock(id: string, patch: Partial<NewPlanBlock>): Promise<PlanBlock>
    removeBlock(id: string): Promise<void>
  }

  /**
   * The deterministic planner. It proposes; it never decides.
   *
   * `proposeDay` computes and returns without writing anything. `fillDraft` writes the
   * proposal into a *draft*, which still has to be accepted before it becomes your plan.
   */
  planner: {
    proposeDay(date: IsoDate, options?: ProposeRequest): Promise<DayProposalDto>
    /** Replaces the planner-placed blocks in a draft with a fresh proposal. */
    fillDraft(planId: string, date: IsoDate, options?: ProposeRequest): Promise<DayPlan>
    /** Same, but leaves everything before the given minute of the day untouched. */
    replanRest(planId: string, date: IsoDate, fromMin: number): Promise<DayPlan>

    /**
     * Plans a stretch of days at once, deadline first, and writes nothing.
     *
     * This is the only thing that can answer "will it be done by the 23rd", because that
     * question is about the hours between now and then rather than about today.
     */
    proposeRange(from: IsoDate, to: IsoDate, options?: ProposeRequest): Promise<RangeProposalDto>

    /**
     * The same proposal, written into each day it touches and accepted there.
     *
     * Only ever called once the user has agreed to a proposal they could read in full —
     * `proposeRange` is the one that computes without writing. Accepting is what makes the
     * plan visible at all: a week is read one accepted day at a time, so stopping at drafts
     * means the caller agreed to a plan and then watched nothing happen.
     */
    applyRange(from: IsoDate, to: IsoDate, options?: ProposeRequest): Promise<RangeProposalDto>
  }

  /**
   * External calendars, and Uurwerk's own layer on top of them.
   *
   * Reading and classifying only at this stage. Connecting a provider is deliberately not
   * here yet — the classification and the Week view work against events from any source,
   * including ones seeded by hand, so nothing about this waits on an account.
   */
  calendar: {
    accounts(): Promise<CalendarAccount[]>
    /**
     * Subscribes to a published calendar link.
     *
     * Read-only by nature, and the only route that needs no permission from whoever runs
     * the mailbox — which is what makes it the one that works on a managed tenant.
     */
    connectIcs(url: string, label?: string): Promise<CalendarSyncResult>
    /**
     * Connects iCloud over CalDAV, which is the only route that can write.
     *
     * `appPassword` is an app-specific password from account.apple.com, never the Apple ID
     * password. It goes straight into the encrypted vault and is never returned.
     */
    connectIcloud(appleId: string, appPassword: string): Promise<CalendarSyncResult>
    /**
     * Writes the accepted plan for a range of days to a calendar Uurwerk owns in iCloud,
     * creating that calendar the first time.
     *
     * Never touches your own calendars. A full reconcile rather than a diff, so pushing an
     * unchanged plan twice does nothing and an interrupted push is fixed by the next one.
     */
    pushPlan(from: IsoDate, to: IsoDate): Promise<PlanPushResult>
    disconnect(accountId: string): Promise<void>
    syncNow(accountId?: string): Promise<CalendarSyncResult[]>
    calendars(accountId?: string): Promise<CalendarSource[]>
    /** Per-calendar defaults: the setting that stops the popup appearing so often. */
    updateCalendar(id: string, patch: Partial<CalendarSource>): Promise<CalendarSource>

    eventsInRange(startMs: number, endMs: number): Promise<CalendarEvent[]>
    /** Everything awaiting a decision, each with the classifier's guess. */
    pending(): Promise<PendingClassificationDto[]>
    suggest(eventId: string): Promise<ClassificationSuggestion>
    classify(eventId: string, choice: ClassificationChoiceDto): Promise<CalendarEvent>
    /** Leaves it visible but unclassified, and out of the planning. */
    ignore(eventId: string): Promise<CalendarEvent>
    /** Moves an appointment; its travel blocks follow unless you detached them. */
    move(eventId: string, startsAt: number, endsAt: number): Promise<CalendarEvent>
    createEvent(event: NewCalendarEvent): Promise<CalendarEvent>

    rules(): Promise<ClassificationRule[]>
    /** Forgetting is a feature: a rule you disagree with stops being applied. */
    forgetRule(id: string): Promise<void>
  }

  /** Standing weekly commitments — a shift, a class, anything that owns the same hours. */
  commitments: {
    list(includeArchived?: boolean): Promise<RecurringCommitment[]>
    create(commitment: NewRecurringCommitment): Promise<RecurringCommitment>
    update(id: string, patch: Partial<RecurringCommitment>): Promise<RecurringCommitment>
    /** Stops it from a date onward without deleting the history it already shaped. */
    end(id: string, lastDay: IsoDate): Promise<RecurringCommitment>
    archive(id: string): Promise<void>
  }

  /** When work can happen at all, before anything is scheduled into it. */
  availability: {
    forWeek(week: IsoWeek): Promise<Availability[]>
    save(entry: Omit<Availability, 'id'> & { id?: string }): Promise<Availability>
    events(from: IsoDate, to: IsoDate): Promise<FixedEvent[]>
    addEvent(event: Omit<FixedEvent, 'id'>): Promise<FixedEvent>
    removeEvent(id: string): Promise<void>
  }

  capture: {
    /**
     * Take one screenshot right now and mark it for the report.
     *
     * Returns null when the focused window is on the blocklist — a deliberate keypress is
     * not an override for that, and the caller is told rather than left guessing.
     */
    markNow(): Promise<Artifact | null>
    listByDay(date: IsoDate, kind?: ArtifactKind): Promise<Artifact[]>
    listByWeek(week: IsoWeek): Promise<Artifact[]>
    /** The report approval gate. */
    setIncluded(id: string, included: boolean): Promise<void>
    /** Same gate, applied to a whole day at once. Returns how many frames it touched. */
    approveDay(date: IsoDate, included: boolean): Promise<number>
    remove(id: string): Promise<void>
    /**
     * Encodes the day's *approved* frames into a .webm. Throws with a readable reason when
     * there are too few, so the UI never has to guess why nothing happened.
     */
    buildTimelapse(date: IsoDate): Promise<Artifact | null>
  }

  reports: {
    build(week: IsoWeek): Promise<WeekReport>
    saveSummary(week: IsoWeek, summary: string): Promise<void>
    /** Writes the Dutch .docx and returns its path. */
    generateDocx(week: IsoWeek): Promise<string>
    /** Draft mode opens the mail client; smtp mode sends directly. Never claims either. */
    send(week: IsoWeek): Promise<SendOutcome>
    openFile(path: string): Promise<void>
  }

  settings: {
    get(): Promise<Settings>
    update(patch: Partial<Settings>): Promise<Settings>
    /** Stored via Electron safeStorage, never returned to the renderer. */
    setSecret(key: 'smtpPassword' | 'publishToken', value: string): Promise<void>
    hasSecret(key: 'smtpPassword' | 'publishToken'): Promise<boolean>
  }

  publish: {
    /** Builds the masked, text-only snapshot without sending it — for preview. */
    preview(): Promise<PublicSnapshot>
    now(): Promise<void>
  }

  /** Windows sign-in behaviour. Owned by the main process; never touched from the renderer. */
  startup: {
    getLoginItemStatus(): Promise<LoginItemStatus>
    setAutoLaunch(enabled: boolean): Promise<LoginItemStatus>
  }

  window: {
    minimizeToTray(): Promise<void>
    closeQuickAdd(): Promise<void>
    /**
     * Ends the app for real, tray and hotkeys included.
     *
     * Closing the window only hides it, which is what "close to tray" is for — so without
     * this the only way out was the tray's own menu, and an app you cannot tell to stop is
     * one people kill from Task Manager. A running timer is stopped and saved on the way
     * out; nothing is lost.
     */
    quit(): Promise<void>
  }
}

/** Whether the app is registered to start with Windows, and whether it even can be. */
export interface LoginItemStatus {
  enabled: boolean
  registered: boolean
  /** False in development, where registering would point at a throwaway path. */
  supported: boolean
  reason: string | null
}
