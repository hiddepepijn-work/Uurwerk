/**
 * ★ Geld and the rest of Uurwerk, kept in step. ★
 *
 *   shifts      ↔ agenda   A shift planned in Geld is an appointment "FedEx · Nacht" with the
 *                          drive there and back; a FedEx appointment made in the agenda is a
 *                          shift in Geld. Moving or deleting either moves or deletes the other.
 *   milestones  → tasks    "Lange vlucht boeken (reis)" with the date as deadline, ticked off
 *                          once the bank shows it paid.
 *   closing     → task     "Geld: oktober afsluiten", ticked off by the closing itself.
 *   hours       → task     "Uren indienen Adecco" for the Monday deadline.
 *
 * Amounts never go into the agenda or a task: those sync to the server in the clear and the
 * agenda reaches iCloud; the numbers stay in the encrypted Geld tables.
 *
 * Tasks and events get random ids, so each carries a marker ("geld:shift:<id>") in its notes
 * or description. That finds it again on any device, and when two devices both made one before
 * syncing, the extra is removed here.
 */

import type { IsoDate, MoneyShift } from '../contract/types.js'
import { SYSTEM_AREAS } from '../contract/types.js'
import type { Store } from '../db/index.js'
import { CalendarService } from '../services/calendar/index.js'
import { atMinuteOfDay, toIsoDate, toIsoWeek } from '../util/time.js'
import { addDays, addMonths, firstOfMonth, monthOf, weekday } from './dates.js'
import { clockMinutes, templateFor } from './pay.js'
import { phaseFor } from './plan.js'
import { milestonePaid } from './projection.js'

export const FEDEX_ORGANIZATION = 'organization-fedex'
/** 8 km by car. */
const TRAVEL_MIN = 12
const MARK = 'geld:'

export interface LinkChanges {
  tasks: boolean
  planning: boolean
  money: boolean
}

interface MarkedTask {
  id: string
  title: string
  status: string
  due_date: string | null
  notes: string
  created_at: number
}

const shiftMark = (id: string): string => `${MARK}shift:${id}`

export class MoneyLink {
  private readonly calendar: CalendarService

  constructor(private readonly store: Store) {
    this.calendar = new CalendarService(store)
  }

  private ensureFedex(): string {
    if (this.store.organizations.get(FEDEX_ORGANIZATION)) return FEDEX_ORGANIZATION
    if (this.store.organizations.bySlug('fedex')) return this.store.organizations.bySlug('fedex')!.id
    return this.store.organizations.create({ id: FEDEX_ORGANIZATION, slug: 'fedex', name: 'FedEx (Adecco)' }).id
  }

  // ------------------------------------------------------------ shifts ↔ agenda

  private times(shift: MoneyShift): { startsAt: number; endsAt: number; label: string } | null {
    const profile = this.store.money.state().profile
    const template = profile ? templateFor(profile, shift.template) : null
    if (!template) return null
    const start = clockMinutes(template.start)
    let end = clockMinutes(template.end)
    if (end <= start) end += 24 * 60
    const startsAt = atMinuteOfDay(shift.date, start)
    return { startsAt, endsAt: startsAt + (end - start) * 60_000, label: template.label }
  }

  /** Every event carrying a shift's marker, deleted ones too (a deletion is information). */
  private shiftEvents(): Array<{ id: string; description: string; deleted: boolean }> {
    return this.store.db
      .all<{ id: string; description: string; deleted_at: number | null }>(
        "SELECT id, description, deleted_at FROM calendar_events WHERE description LIKE 'geld:shift:%' AND event_kind = 'appointment'"
      )
      .map((row) => ({ id: row.id, description: row.description, deleted: row.deleted_at !== null }))
  }

  /** A shift planned in Geld: its appointment, made or moved. */
  pushShift(shift: MoneyShift): void {
    const times = this.times(shift)
    if (!times) return
    const existing = this.shiftEvents().find((event) => event.description === shiftMark(shift.id) && !event.deleted)
    const title = `FedEx · ${times.label}`
    if (existing) {
      const event = this.store.calendar.event(existing.id)!
      if (event.startsAt !== times.startsAt || event.endsAt !== times.endsAt) this.calendar.moveEvent(event.id, times.startsAt, times.endsAt)
      if (event.title !== title) this.store.calendar.updateEvent(event.id, { title })
      return
    }
    const organizationId = this.ensureFedex()
    const created = this.store.calendar.createEvent({
      title,
      description: shiftMark(shift.id),
      location: 'FedEx Duiven',
      startsAt: times.startsAt,
      endsAt: times.endsAt,
      origin: 'uurwerk',
      areaId: SYSTEM_AREAS.work,
      organizationId,
      classificationStatus: 'unclassified',
      includeInPlanning: true,
      registrationMode: 'none',
      countsAsWorked: false
    })
    this.calendar.applyClassification(created.id, {
      areaId: SYSTEM_AREAS.work,
      organizationId,
      projectId: null,
      workTypeId: null,
      remember: false,
      includeInPlanning: true,
      registrationMode: 'none',
      countsAsWorked: false,
      travel: { outboundMin: TRAVEL_MIN, returnMin: TRAVEL_MIN, countsAsWorked: false }
    })
  }

  /** A shift removed in Geld: its appointment and the drive go too. */
  dropShift(shiftId: string): void {
    for (const event of this.shiftEvents()) {
      if (event.description !== shiftMark(shiftId) || event.deleted) continue
      for (const travel of this.store.calendar.travelFor(event.id)) this.store.calendar.softDelete(travel.id)
      this.store.calendar.softDelete(event.id)
    }
  }

  /** The template whose start is nearest to an appointment's start. */
  private templateAt(startsAt: number): string | null {
    const profile = this.store.money.state().profile
    if (!profile || profile.templates.length === 0) return null
    const date = new Date(startsAt)
    const minute = date.getHours() * 60 + date.getMinutes()
    const distance = (clock: string): number => {
      const difference = Math.abs(clockMinutes(clock) - minute)
      return Math.min(difference, 24 * 60 - difference)
    }
    return [...profile.templates].sort((a, b) => distance(a.start) - distance(b.start))[0]!.key
  }

  private reconcileShifts(today: IsoDate, changes: LinkChanges): void {
    const money = this.store.money
    const shifts = new Map(money.state().shifts.map((shift) => [shift.id, shift]))
    const events = this.shiftEvents()
    const byShift = new Map<string, typeof events>()
    for (const event of events) {
      const id = event.description.slice(`${MARK}shift:`.length)
      byShift.set(id, [...(byShift.get(id) ?? []), event])
    }

    // Agenda → Geld: FedEx appointments without a shift become one.
    const fedex = this.store.db.all<{ id: string; starts_at: number; description: string | null }>(
      `SELECT id, starts_at, description FROM calendar_events
        WHERE organization_id = ? AND event_kind = 'appointment' AND deleted_at IS NULL AND cancelled = 0 AND starts_at >= ?`,
      [FEDEX_ORGANIZATION, atMinuteOfDay(addDays(today, -60), 0)]
    )
    for (const event of fedex) {
      const template = this.templateAt(event.starts_at)
      if (!template) continue
      const date = toIsoDate(event.starts_at)
      const marked = event.description?.startsWith(`${MARK}shift:`) ? event.description.slice(`${MARK}shift:`.length) : null
      const id = marked ?? `agenda-${event.id}`
      const shift = shifts.get(id)
      if (!marked) {
        this.store.calendar.updateEvent(event.id, { description: shiftMark(id) })
        changes.planning = true
      }
      if (!shift) {
        money.saveShift({ id, date, template, status: date < today ? 'worked' : 'planned' })
        changes.money = true
      } else if (shift.date !== date || shift.template !== template) {
        money.saveShift({ ...shift, date, template })
        changes.money = true
      }
    }

    // Deleted in the agenda: gone from Geld too.
    for (const [id, list] of this.shiftEvents().reduce((map, event) => {
      const key = event.description.slice(`${MARK}shift:`.length)
      return map.set(key, [...(map.get(key) ?? []), event])
    }, new Map<string, ReturnType<MoneyLink['shiftEvents']>>())) {
      if (shifts.has(id) && list.every((event) => event.deleted)) {
        money.removeShift(id)
        shifts.delete(id)
        changes.money = true
      }
    }

    // Geld → agenda: recent and future shifts without an appointment get one; doubles go.
    for (const shift of money.state().shifts) {
      if (shift.date < addDays(today, -7)) continue
      const live = (byShift.get(shift.id) ?? []).filter((event) => !event.deleted)
      if (live.length === 0 && !(byShift.get(shift.id) ?? []).some((event) => event.deleted)) {
        this.pushShift(shift)
        changes.planning = true
      }
      for (const extra of live.slice(1)) {
        for (const travel of this.store.calendar.travelFor(extra.id)) this.store.calendar.softDelete(travel.id)
        this.store.calendar.softDelete(extra.id)
        changes.planning = true
      }
    }
  }

  /** A night shift that ends the morning of a stage day: the stage starts before noon. */
  nightBeforeStage(shift: MoneyShift): boolean {
    const times = this.times(shift)
    if (!times) return false
    const endDate = toIsoDate(times.endsAt)
    if (endDate === shift.date) return false
    const day = this.store.availability.forWeek(toIsoWeek(new Date(times.endsAt))).find((item) => item.weekday === weekday(endDate))
    return Boolean(day?.enabled && day.stageStartMin !== null && day.stageStartMin < 12 * 60)
  }

  // ------------------------------------------------------------ tasks

  private markedTasks(prefix: string): MarkedTask[] {
    return this.store.db.all<MarkedTask>(
      "SELECT id, title, status, due_date, notes, created_at FROM tasks WHERE notes LIKE ? AND status <> 'archived' ORDER BY created_at",
      [`${MARK}${prefix}%`]
    )
  }

  /**
   * One task per marker: made when missing, title and deadline kept right, done when `done`,
   * the extras from a second device removed. A task you ticked off yourself stays ticked.
   */
  private ensureTask(marker: string, title: string, dueDate: IsoDate, areaId: string, done: boolean, changes: LinkChanges): void {
    const found = this.store.db.all<MarkedTask>('SELECT id, title, status, due_date, notes, created_at FROM tasks WHERE notes = ? ORDER BY created_at', [marker])
    for (const extra of found.slice(1)) {
      this.store.tasks.remove(extra.id)
      changes.tasks = true
    }
    const task = found[0]
    if (!task) {
      const created = this.store.tasks.create({ title, areaId, dueDate, notes: marker, priority: 'high' })
      if (done) this.store.tasks.complete(created.id, true)
      changes.tasks = true
      return
    }
    if (task.title !== title || task.due_date !== dueDate) {
      this.store.tasks.update(task.id, { title, dueDate })
      changes.tasks = true
    }
    if (done && task.status !== 'done') {
      this.store.tasks.complete(task.id, true)
      changes.tasks = true
    }
  }

  private reconcileTasks(today: IsoDate, changes: LinkChanges): void {
    const state = this.store.money.state()

    // Milestones: one task each; gone when the milestone is.
    const ids = new Set(state.milestones.map((milestone) => milestone.id))
    for (const milestone of state.milestones) {
      this.ensureTask(`${MARK}milestone:${milestone.id}`, `${milestone.name} (reis)`, milestone.date, SYSTEM_AREAS.personal, milestonePaid(state, milestone), changes)
    }
    for (const task of this.markedTasks('milestone:')) {
      if (!ids.has(task.notes.slice(`${MARK}milestone:`.length))) {
        this.store.tasks.remove(task.id)
        changes.tasks = true
      }
    }

    // Closing: the month just ended, done once it is closed.
    const previous = addMonths(monthOf(today), -1)
    if (phaseFor(state.phases, previous)) {
      const closed = state.closings.some((closing) => closing.month === previous)
      const name = new Date(`${previous}-15T12:00:00`).toLocaleString('nl-NL', { month: 'long' })
      this.ensureTask(`${MARK}close:${previous}`, `Geld: ${name} afsluiten`, addDays(firstOfMonth(monthOf(today)), 2), SYSTEM_AREAS.personal, closed, changes)
    }
    for (const closing of state.closings) {
      const task = this.markedTasks(`close:${closing.month}`)[0]
      if (task && task.status !== 'done') {
        this.store.tasks.complete(task.id, true)
        changes.tasks = true
      }
    }

    // Hours: the Monday after a week with shifts.
    const monday = addDays(today, (8 - weekday(today)) % 7)
    const worked = state.shifts.some((shift) => shift.date >= addDays(monday, -7) && shift.date < monday)
    if (worked && monday >= today) {
      this.ensureTask(`${MARK}hours:${monday}`, 'Uren indienen Adecco (vóór 12:00)', monday, SYSTEM_AREAS.work, false, changes)
    }
  }

  /** Brings agenda, tasks and Geld in line. Cheap enough to run on every Geld read. */
  reconcile(today: IsoDate): LinkChanges {
    const changes: LinkChanges = { tasks: false, planning: false, money: false }
    if (this.store.money.isEmpty()) return changes
    this.store.db.transaction(() => {
      // FedEx exists as an organization, so it can be picked for an appointment in the agenda.
      if (!this.store.organizations.get(FEDEX_ORGANIZATION) && !this.store.organizations.bySlug('fedex')) {
        this.ensureFedex()
        changes.planning = true
      }
      this.reconcileShifts(today, changes)
      this.reconcileTasks(today, changes)
    })
    return changes
  }
}

