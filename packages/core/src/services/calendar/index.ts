/**
 * The calendar service: everything the app asks about external events.
 *
 * It sits between the repositories and the seam so the IPC layer stays a translation of
 * plain data, and so the same behaviour would hold for a web view that never touches
 * Electron. Providers live in the main process; nothing here knows Microsoft or Apple exists.
 */

import type {
  CalendarEvent,
  ClassificationRule,
  ClassificationSuggestion,
  RegistrationMode,
  TravelPlan
} from '../../contract/types.js'
import type { Store } from '../../db/index.js'
import {
  classify,
  decideAction,
  rulesToLearn,
  type ClassifiableEvent,
  type ClassificationAction
} from './classify.js'
import { registrableWindow } from './reconcile.js'
import { travelAfterParentMoved, travelEventsFor } from './travel.js'

export interface ClassificationChoice {
  areaId: string | null
  organizationId: string | null
  projectId: string | null
  workTypeId: string | null
  /** Whether to write rules so events like this stop asking. */
  remember: boolean
  includeInPlanning: boolean
  registrationMode: RegistrationMode
  countsAsWorked: boolean
  /** Absent means no journey; zero minutes in either direction is the same thing. */
  travel?: TravelPlan
}

/** An event that still needs a decision, with the guess already made. */
export interface PendingClassification {
  event: CalendarEvent
  suggestion: ClassificationSuggestion
  action: ClassificationAction
}

export class CalendarService {
  constructor(private readonly store: Store) {}

  /** The classifier's view of the world: your own names, plus what it has learned. */
  private context(): {
    rules: ClassificationRule[]
    areas: ReturnType<Store['areas']['list']>
    organizations: ReturnType<Store['organizations']['list']>
    projects: ReturnType<Store['projects']['list']>
    workTypes: ReturnType<Store['workTypes']['list']>
  } {
    return {
      rules: this.store.calendarRules.list(),
      areas: this.store.areas.list(),
      organizations: this.store.organizations.list(),
      projects: this.store.projects.list(),
      workTypes: this.store.workTypes.list()
    }
  }

  private asClassifiable(event: CalendarEvent): ClassifiableEvent {
    const link = this.store.calendar.links(event.id)[0]
    const calendar = link?.calendarId ? this.store.calendar.calendar(link.calendarId) : null

    return {
      title: event.title,
      location: event.location,
      organizer: event.organizer,
      attendees: event.attendees,
      calendar
    }
  }

  /** What the classifier thinks about one event, without changing anything. */
  suggestFor(eventId: string): ClassificationSuggestion {
    const event = this.store.calendar.event(eventId)
    if (!event) throw new Error(`Calendar event not found: ${eventId}`)
    return classify(this.asClassifiable(event), this.context())
  }

  /**
   * Everything waiting on a decision, with the guess and what to do about it.
   *
   * The action is what decides whether you are interrupted: 'classify' means confident
   * enough to apply silently, 'suggest' opens the popup pre-filled, 'ask' opens it blank.
   */
  pending(
    behaviour: 'automatic' | 'ask-when-uncertain' | 'always-ask' | 'never' = 'ask-when-uncertain',
    askBelow?: number
  ): PendingClassification[] {
    const context = this.context()

    return this.store.calendar.unclassified().map((event) => {
      const suggestion = classify(this.asClassifiable(event), context)
      return {
        event,
        suggestion,
        action: decideAction(suggestion.confidence, behaviour, askBelow)
      }
    })
  }

  /**
   * Applies a classification, and everything that follows from it.
   *
   * One call so the pieces cannot drift apart: the event is classified, the rules are
   * learned if you asked, and the travel blocks are created, replaced or removed to match.
   */
  applyClassification(eventId: string, choice: ClassificationChoice): CalendarEvent {
    const event = this.store.calendar.event(eventId)
    if (!event) throw new Error(`Calendar event not found: ${eventId}`)

    return this.store.db.transaction(() => {
      const classified = this.store.calendar.updateEvent(eventId, {
        areaId: choice.areaId,
        organizationId: choice.organizationId,
        projectId: choice.projectId,
        workTypeId: choice.workTypeId,
        classificationStatus: 'confirmed',
        // A confirmed classification is certain by definition; the score described a guess.
        confidence: null,
        includeInPlanning: choice.includeInPlanning,
        registrationMode: choice.registrationMode,
        countsAsWorked: choice.countsAsWorked
      })

      if (choice.remember) {
        for (const rule of rulesToLearn(this.asClassifiable(classified), choice)) {
          this.store.calendarRules.learn({
            matcher: rule.matcher,
            pattern: rule.pattern,
            areaId: choice.areaId,
            organizationId: choice.organizationId,
            projectId: choice.projectId,
            workTypeId: choice.workTypeId
          })
        }
      }

      this.setTravel(classified, choice.travel)
      // The whole point of the decision you just made: the hours have to exist as hours.
      this.reconcileTree(eventId)
      return this.store.calendar.event(eventId)!
    })
  }

  // --------------------------------------------------------- hours from events

  /**
   * Rewrites the time segment behind one event to match its current classification.
   *
   * Deleted and recreated rather than patched — see the note in `reconcile.ts`. Returns the
   * event as it now stands, since the reconciled segment id lives on it.
   */
  reconcileHours(eventId: string): CalendarEvent {
    return this.store.db.transaction(() => {
      const event = this.store.calendar.event(eventId)
      if (!event) throw new Error(`Calendar event not found: ${eventId}`)

      if (event.reconciledSegmentId) this.dropReconciled(event.reconciledSegmentId)

      const window = registrableWindow(event)
      if (!window) {
        return event.reconciledSegmentId
          ? this.store.calendar.updateEvent(eventId, { reconciledSegmentId: null })
          : event
      }

      // Its own run, closed the moment it is opened. An appointment is a self-contained
      // stretch of work, and folding it into whatever run happens to be live would splice
      // an hour you did not sit at the machine for into the middle of one you did.
      const area = event.areaId ? this.store.areas.get(event.areaId) : null
      const run = this.store.tracking.startRun(window.startedAt, event.title)
      const segment = this.store.tracking.startSegment({
        trackingRunId: run.id,
        // No task: an appointment is not one, and inventing a link would put hours nobody
        // planned into planned-versus-actual as unplanned work against a real task.
        taskId: null,
        areaId: area?.id ?? null,
        countsAsStageHours: area?.countsAsStageHours ?? false,
        at: window.startedAt
      })
      this.store.tracking.endSegment(segment.id, window.endedAt, 'stopped', { note: event.title })
      this.store.tracking.endRun(run.id, window.endedAt)

      return this.store.calendar.updateEvent(eventId, { reconciledSegmentId: segment.id })
    })
  }

  /** An appointment and its travel blocks: they register their hours as a set. */
  private reconcileTree(parentId: string): void {
    this.reconcileHours(parentId)
    for (const block of this.store.calendar.travelFor(parentId)) {
      this.reconcileHours(block.id)
    }
  }

  /** Removes a derived segment, and the run around it once nothing is left in it. */
  private dropReconciled(segmentId: string): void {
    const segment = this.store.tracking.getSegment(segmentId)
    if (!segment) return

    const runId = segment.trackingRunId
    this.store.tracking.removeSegment(segmentId)
    if (this.store.tracking.segmentsForRun(runId).length === 0) {
      this.store.tracking.removeRun(runId)
    }
  }

  /**
   * Leaves the event visible and unclassified — 'skip' in the popup.
   *
   * Registration goes with it. An event that is not filed under anything cannot be an hour
   * on your internship, and leaving the hours behind would strand a segment whose reason for
   * existing had just been withdrawn — invisible in the calendar, still in every total.
   */
  ignore(eventId: string): CalendarEvent {
    return this.store.db.transaction(() => {
      this.store.calendar.updateEvent(eventId, {
        classificationStatus: 'ignored',
        includeInPlanning: false,
        registrationMode: 'none',
        countsAsWorked: false
      })

      // The journey has its own registration, and it does not survive the appointment it
      // was made for. Clearing only the parent leaves the travel quietly counting on its
      // own — an hour of driving to a meeting that, as far as the app is concerned, you
      // are no longer going to.
      for (const block of this.store.calendar.travelFor(eventId)) {
        this.store.calendar.updateEvent(block.id, {
          registrationMode: 'none',
          countsAsWorked: false,
          includeInPlanning: false
        })
      }

      this.reconcileTree(eventId)
      return this.store.calendar.event(eventId)!
    })
  }

  /**
   * Brings an event's travel blocks in line with a plan.
   *
   * Rebuilt rather than patched: the journey either exists with these durations or it does
   * not, and a half-updated pair is harder to reason about than two fresh rows. Blocks you
   * detached by hand are left alone — your edit outranks a regeneration.
   */
  setTravel(parent: CalendarEvent, plan?: TravelPlan): CalendarEvent[] {
    const existing = this.store.calendar.travelFor(parent.id)

    for (const block of existing) {
      if (block.travelDetached) continue
      // A journey that no longer exists must not go on contributing hours: the segment goes
      // with the block, or withdrawing travel would leave its time behind for good.
      if (block.reconciledSegmentId) this.dropReconciled(block.reconciledSegmentId)
      this.store.calendar.softDelete(block.id)
    }

    if (!plan || (plan.outboundMin <= 0 && plan.returnMin <= 0)) return []

    return travelEventsFor(parent, plan).map((input) => this.store.calendar.createEvent(input))
  }

  /**
   * Moves or resizes an appointment, dragging its travel along.
   *
   * The one behaviour that makes travel-as-events worth it: the meeting slips an hour and
   * the journeys either side follow, keeping their own durations.
   */
  moveEvent(eventId: string, startsAt: number, endsAt: number): CalendarEvent {
    return this.store.db.transaction(() => {
      const moved = this.store.calendar.updateEvent(eventId, { startsAt, endsAt })

      for (const shift of travelAfterParentMoved(moved, this.store.calendar.travelFor(eventId))) {
        this.store.calendar.updateEvent(shift.eventId, {
          startsAt: shift.startsAt,
          endsAt: shift.endsAt
        })
      }

      // Hours registered from this event were registered at the old time. A meeting that
      // slips to Thursday takes its hours to Thursday with it.
      this.reconcileTree(eventId)
      return this.store.calendar.event(eventId)!
    })
  }

  /**
   * Events overlapping a range, for the Week view.
   *
   * Cancelled and deleted rows never appear, and travel comes back alongside its parent so
   * the grid can draw the whole shape of an afternoon.
   */
  eventsInRange(startMs: number, endMs: number): CalendarEvent[] {
    return this.store.calendar.eventsInRange(startMs, endMs)
  }

  /**
   * Calendar events as planner walls.
   *
   * Only what actually blocks time: an event you excluded from planning, or one from a
   * calendar marked ignore-for-planning, is visible without owning the hour.
   */
  busyInRange(startMs: number, endMs: number): CalendarEvent[] {
    return this.store.calendar.eventsInRange(startMs, endMs).filter((event) => {
      if (!event.includeInPlanning) return false
      if (event.classificationStatus === 'ignored') return false

      const link = this.store.calendar.links(event.id)[0]
      const calendar = link?.calendarId ? this.store.calendar.calendar(link.calendarId) : null
      return !calendar?.ignoreForPlanning
    })
  }
}

export { classify, decideAction, rulesToLearn } from './classify.js'
export { registrableMinutes, travelEventsFor, TRAVEL_WORK_TYPE_ID } from './travel.js'
export type { ClassifiableEvent, ClassificationAction } from './classify.js'
