/**
 * Preparation: what has to happen before a task or appointment, put in by itself.
 *
 * Hidde, 26 Oct 2026: "als ik een herkansing heb staan, dat hij automatisch nog een todo in
 * zet van checken wat ik moet inleveren, of voor een reis tas inpakken en ook notificaties
 * stuurt." So every task with a deadline and every appointment in the coming month is looked
 * at once:
 *
 *   resit, exam, hand-in     → "Checken wat ik moet inleveren/kennen" a week before
 *   trip, holiday, flight    → "Tas pakken" the day before, with a checklist and a reminder
 *   important, no template   → marked "asked": a notification asks until it is answered
 *   anything else            → left unchecked, for Jarvis (and Claude) to ask about
 *
 * The prep task's id is derived from what it prepares, so the laptop and the phone running
 * the same sweep write the same row instead of two. Whatever the sweep decides is written to
 * prep_checks, so a prep task Hidde deletes stays deleted.
 */

import type { CalendarEvent, ChecklistItem, IsoDate, Task } from '../contract/types.js'
import type { Store } from '../db/index.js'
import { fromIsoDate, toIsoDate } from '../util/time.js'
import { markedImportant, type ExtraNudgeInput } from './reminders.js'

const HORIZON_DAYS = 30

export type PrepTemplate = 'exam' | 'trip'

const EXAM = /herkansing|tentamen|toets|examen|assessment|presentatie|verdediging|inlever|deadline|oplever/i
const TRIP = /\breis\b|vlucht|vakantie|weekend ?weg|kamp\b|festival|\btrip\b|logeren|vliegveld|citytrip/i

/** Which preparation a title asks for, if any. Trips first: "vlucht inleveren" is rare. */
export function prepTemplate(title: string): PrepTemplate | null {
  // A reminder of something is not the thing itself: it needs no preparation of its own.
  if (/^\s*herinnering\b/i.test(title)) return null
  if (TRIP.test(title)) return 'trip'
  if (EXAM.test(title)) return 'exam'
  return null
}

export const TRIP_CHECKLIST: ChecklistItem[] = [
  'ID / paspoort',
  'Telefoon + oplader',
  'Tickets en boekingen',
  'Medicijnen',
  'Kleding',
  'Toilettas',
  'Pinpas / geld'
].map((text) => ({ text, done: false }))

const addDays = (day: IsoDate, days: number): IsoDate => {
  const d = fromIsoDate(day)
  d.setDate(d.getDate() + days)
  return toIsoDate(d.getTime())
}

const later = (a: IsoDate, b: IsoDate): IsoDate => (a > b ? a : b)

const shortDate = (day: IsoDate): string => {
  const d = fromIsoDate(day)
  return `${['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'][d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}`
}

/** Something that may need preparing: a task with a deadline, or an appointment. */
export interface PrepItem {
  ref: string
  title: string
  date: IsoDate
  areaId: string | null
  important: boolean
}

const fromTask = (task: Task): PrepItem => ({
  ref: `t:${task.id}`,
  title: task.title,
  date: task.dueDate!,
  areaId: task.areaId,
  important: markedImportant(task)
})

const fromEvent = (event: CalendarEvent): PrepItem => ({
  ref: `a:${event.id}`,
  title: event.title,
  date: toIsoDate(event.startsAt),
  areaId: event.areaId,
  // Somewhere else, or marked so: worth asking about.
  important: /belangrijk:\s*ja/i.test(event.description ?? '') || (!!event.location && !/online|teams|zoom|thuis/i.test(event.location))
})

/** Tasks with a deadline and appointments in the coming month, prep tasks themselves left out. */
export function prepItems(store: Store, nowMs: number): PrepItem[] {
  const today = toIsoDate(nowMs)
  const until = addDays(today, HORIZON_DAYS)
  const tasks = store.tasks
    .list({ status: 'active' })
    .filter((task) => task.dueDate && task.dueDate >= today && task.dueDate <= until && !task.prepFor)
  const events = store.calendar
    .eventsInRange(nowMs, fromIsoDate(until).getTime() + 86_400_000)
    .filter((event) => event.kind !== 'travel' && !event.cancelled && !event.deletedAt && event.startsAt >= nowMs)
  return [...tasks.map(fromTask), ...events.map(fromEvent)]
}

/** The prep task's id: the same on every device for the same item. */
export const prepTaskId = (ref: string): string => `prep-${ref.replace(':', '-')}`

/** The prep task for one item and template; not written. */
export function prepTask(item: PrepItem, template: PrepTemplate, today: IsoDate) {
  const when = shortDate(item.date)
  if (template === 'trip') {
    const due = later(today, addDays(item.date, -1))
    return {
      title: `Tas pakken: ${item.title}`,
      areaId: item.areaId,
      priority: 'high' as const,
      estimateMin: 30,
      dueDate: due,
      notes: `Automatisch: hoort bij ${item.title} (${when}).`,
      checklist: TRIP_CHECKLIST,
      remindAt: [`${due}T19:30`],
      prepFor: item.ref
    }
  }
  const due = later(today, addDays(item.date, -7))
  return {
    title: `Checken wat ik moet inleveren/kennen: ${item.title}`,
    areaId: item.areaId,
    priority: 'high' as const,
    estimateMin: 30,
    dueDate: due,
    notes: `Automatisch: hoort bij ${item.title} (${when}). Wat moet er af of mee, en is dat er al?`,
    checklist: [] as ChecklistItem[],
    remindAt: [`${due}T09:00`],
    prepFor: item.ref
  }
}

/**
 * Looks at every item nobody has checked yet. Returns what it did, for the log and tests.
 * Safe to run often and on more than one device.
 */
export function prepSweep(store: Store, nowMs: number): { created: string[]; asked: string[] } {
  const today = toIsoDate(nowMs)
  const checked = store.prep.all()
  const created: string[] = []
  const asked: string[] = []

  for (const item of prepItems(store, nowMs)) {
    if (checked.has(item.ref)) continue
    const template = prepTemplate(item.title)
    if (template) {
      const id = prepTaskId(item.ref)
      if (!store.tasks.get(id)) {
        store.tasks.create(prepTask(item, template, today), id)
        created.push(id)
      }
      store.prep.set(item.ref, 'planned', `Voorbereiding: ${template === 'trip' ? 'tas pakken' : 'inleveren checken'}`)
    } else if (item.important) {
      store.prep.set(item.ref, 'asked')
      asked.push(item.ref)
    }
  }
  return { created, asked }
}

/** Items still waiting for an answer, or never looked at: what Jarvis should ask about. */
export function prepOpen(store: Store, nowMs: number): { asked: PrepItem[]; unchecked: PrepItem[] } {
  const checks = store.prep.all()
  const items = prepItems(store, nowMs)
  return {
    asked: items.filter((item) => checks.get(item.ref)?.status === 'asked'),
    unchecked: items.filter((item) => !checks.has(item.ref))
  }
}

/** What extraNudges needs, read from the store: the same on the laptop and the phone. */
export function extraNudgeInput(store: Store, nowMs: number): ExtraNudgeInput {
  return {
    tasks: store.tasks.list({ status: 'active' }),
    plannedMinOn: (day) => {
      const plan = store.plans.accepted('day', day)
      if (!plan) return 0
      return store.plans
        .blocks(plan.id)
        .filter((block) => block.kind === 'task')
        .reduce((sum, block) => sum + (block.endMin - block.startMin), 0)
    },
    prepAsked: prepOpen(store, nowMs).asked.map((item) => item.title)
  }
}
