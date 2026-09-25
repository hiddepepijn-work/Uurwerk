/**
 * The IPC channel manifest.
 *
 * Both sides of the bridge are generated from this one list — main registers a handler per
 * entry, preload builds the matching `window.api` object. That is what stops the classic
 * Electron rot where thirty files each invent their own channel name and nobody can tell
 * which are still live.
 *
 * Adding a method to TimeTrackerAPI means adding it here. Miss it and the call simply is
 * not exposed, which is a loud failure rather than a silent one.
 */

export const CHANNELS = {
  areas: ['list', 'create', 'update', 'archive'],
  // Who work is for, and what kind of work it is. Both sit beside `areas` rather than
  // inside it: an organization never implies an area, and neither implies the other.
  organizations: ['list', 'create', 'update', 'archive'],
  workTypes: ['list', 'create', 'archive'],
  breakdown: ['day', 'week', 'range'],
  // Retro-attribution. `apply` replaces the day's whole division rather than adding to it,
  // which is what makes correcting a mistake the same gesture as making the split.
  // `day`/`apply`/`revert` divide a whole day; the `*Stretch` four work on one stretch
  // and leave the rest of the day alone, which is what makes hand-entered hours safe from
  // tonight's percentages.
  attribution: [
    'day',
    'apply',
    'revert',
    'stretch',
    'addStretch',
    'updateStretch',
    'removeStretch'
  ],
  // One call per screen refresh: every panel has to describe the same range, and separate
  // calls are how a dashboard ends up contradicting itself by one day.
  statistics: ['overview'],
  // `overview` is the dependency-ordered read of one project: what is where, what can be
  // started now, and when each piece is scheduled.
  projects: ['list', 'create', 'update', 'setShareable', 'overview'],
  // No `reorder`: the lists sort by priority and then by creation, and nothing ever offered
  // a drag handle. It went the way of the other channels that existed only in the manifest.
  tasks: ['list', 'get', 'create', 'update', 'complete', 'remove'],
  dependencies: ['list', 'forTask', 'set', 'remove'],
  // There is no `timer` domain any more. It read and wrote the pre-planner `sessions`
  // table, which nothing has written to since tracking moved to runs and segments — so
  // every one of its methods returned an empty list or deleted nothing. `tracking` is the
  // live surface; TimerService survives only as the source of the timer:changed event.
  tracking: [
    'startRun',
    'stopRun',
    'switchTask',
    'completeAndSwitch',
    'blockAndSwitch',
    'currentRun',
    'currentSegment',
    'segmentsByDay',
    'segmentsByWeek',
    'totals',
    'updateSegment',
    'removeSegment'
  ],
  // schedule/move/unschedule are gone with the same reasoning: they wrote rows into
  // `planned`, which no reader consults. Editing a plan goes through `plans`.
  planning: ['week', 'unscheduled', 'plannedVsActual'],
  stats: ['day', 'week', 'timeline'],
  days: ['review', 'get', 'saveSummary', 'saveFlags', 'publish', 'unpublish'],
  plans: [
    'day',
    'week',
    'draft',
    // A draft nothing reads is planning that counts for nothing; these two are how the UI
    // finds them and promotes them.
    'pending',
    'accept',
    'acceptMany',
    'discard',
    'discardMany',
    // Discarding a draft keeps whatever it branched from; this is how a day becomes unplanned.
    'clearDay',
    'addBlock',
    'updateBlock',
    'removeBlock'
  ],
  availability: ['forWeek', 'save', 'events', 'addEvent', 'removeEvent'],
  planner: ['proposeDay', 'fillDraft', 'replanRest', 'proposeRange', 'applyRange'],
  // Standing weekly commitments: shifts, classes, anything that owns the same hours every
  // week. They are walls to the planner and hours to the statistics.
  commitments: ['list', 'create', 'update', 'end', 'archive'],
  // External calendars. Reading and classifying only for now: connecting a provider comes
  // with its own account plumbing, and none of this needs it.
  calendar: [
    'accounts',
    'connectIcs',
    // iCloud over CalDAV: the only provider that can be written to, and `pushPlan` is the
    // only thing that writes — to a calendar Uurwerk creates and owns.
    'connectIcloud',
    'pushPlan',
    'disconnect',
    'syncNow',
    'calendars',
    'updateCalendar',
    'eventsInRange',
    'pending',
    'suggest',
    'classify',
    'ignore',
    'move',
    'createEvent',
    'rules',
    'forgetRule'
  ],
  capture: [
    'markNow',
    'listByDay',
    'listByWeek',
    'setIncluded',
    'approveDay',
    'remove',
    'buildTimelapse'
  ],
  reports: ['build', 'saveSummary', 'generateDocx', 'send', 'openFile'],
  settings: ['get', 'update', 'setSecret', 'hasSecret'],
  publish: ['preview', 'now'],
  startup: ['getLoginItemStatus', 'setAutoLaunch'],
  // `quit` is the real exit: closing the window only hides it when close-to-tray is on.
  window: ['minimizeToTray', 'closeQuickAdd', 'quit'],
  // This copy and the VPS. Offline first: everything above works without it.
  sync: ['status', 'pair', 'now', 'unpair']
} as const

export type ChannelDomain = keyof typeof CHANNELS

/** 'tasks:create', 'timer:start', … */
export const channelName = (domain: string, method: string): string => `${domain}:${method}`

/** Flat list of every valid channel, used to register and to validate. */
export const ALL_CHANNELS: string[] = Object.entries(CHANNELS).flatMap(([domain, methods]) =>
  (methods as readonly string[]).map((method) => channelName(domain, method))
)

/** The event channel; payloads are typed by AppEvents in events.ts. */
export const EVENT_CHANNEL = 'app:event'
