/**
 * The reminders that come before things start: the same list for the phone (local
 * notifications) and the laptop (desktop notifications), so both say the same thing at
 * the same moment.
 *
 *   planned task             30 and 15 min before, and as it starts
 *   appointment, no travel   30 and 15 min before, and as it starts
 *   planned task, halfway    "Ben je al bezig met <task>?"   (Ja, bezig / Nog niet)
 *   planned task, at its end "Is <task> gelukt?"            (Gelukt / Nog niet af)
 *   appointment with travel  30 min before leaving   "Verzamel je spullen"
 *                            15 min before leaving   "Hidde, lukt het?" — spoken
 *
 * Leaving is when the outbound travel block starts. Nothing here knows about platforms.
 *
 * Each warning carries a cue: the sound that says how close it is (scripts/cue-sounds.ts).
 * One soft bell at 30 minutes, two at 15, a fanfare when it starts.
 */

import type { CalendarEvent, PlanBlock, Task } from '../contract/types.js'
import { fromIsoDate, toIsoDate } from '../util/time.js'

export type ReminderKind = 'task' | 'appointment' | 'gather' | 'leave' | 'checkin' | 'nudge'

/** How close the thing is, as a sound. */
export type ReminderCue = 'soon30' | 'soon15' | 'begins'

export interface Reminder {
  /** Stable across recomputes, so a reschedule replaces rather than duplicates. */
  key: string
  kind: ReminderKind
  at: number
  title: string
  body: string
  cue?: ReminderCue
  /** A check-in on a planned task: the notification gets answer buttons. */
  checkin?: { taskId: string; stage: 'midway' | 'end'; important: boolean; task: string }
}

/**
 * Important: Jarvis comes in when Hidde says "nog niet". High priority, or a deadline within
 * two days of the block.
 */
export function isImportant(task: Pick<Task, 'priority' | 'dueDate'>, day: string): boolean {
  if (task.priority === 'high') return true
  if (!task.dueDate) return false
  return (fromIsoDate(task.dueDate).getTime() - fromIsoDate(day).getTime()) / 86_400_000 <= 2
}

const MIN = 60_000

const clock = (ms: number): string =>
  new Date(ms).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })

/** The three warnings before something starts, earliest first. */
const WARNINGS: { minutes: number; cue: ReminderCue }[] = [
  { minutes: 30, cue: 'soon30' },
  { minutes: 15, cue: 'soon15' },
  { minutes: 0, cue: 'begins' }
]

const lead = (minutes: number): string => (minutes === 0 ? 'Nu' : `Over ${minutes} min`)

export function upcomingReminders(
  blocks: PlanBlock[],
  events: CalendarEvent[],
  fromMs: number,
  toMs: number,
  /** The task behind a block, for the check-ins: none are made without it. */
  taskOf?: (taskId: string) => Pick<Task, 'priority' | 'dueDate' | 'status'> | null
): Reminder[] {
  const out: Reminder[] = []

  for (const block of blocks) {
    if (block.kind !== 'task') continue
    const start = fromIsoDate(block.date).getTime() + block.startMin * MIN
    const end = fromIsoDate(block.date).getTime() + block.endMin * MIN
    for (const { minutes, cue } of WARNINGS) {
      out.push({
        key: minutes === 15 ? `task:${block.id}:${start}` : `task:${block.id}:${start}:${minutes}`,
        kind: 'task',
        at: start - minutes * MIN,
        title: block.taskTitle ?? block.title ?? 'Volgende taak',
        body: `${lead(minutes)} · ${clock(start)}–${clock(end)}${block.projectName ? ` · ${block.projectName}` : ''}`,
        cue
      })
    }

    // Check-ins: halfway (only for half an hour or more) whether he started, at the end whether it
    // is done. A task that is already done gets neither.
    const task = block.taskId && taskOf ? taskOf(block.taskId) : null
    if (!task || !block.taskId || task.status === 'done') continue
    const name = block.taskTitle ?? block.title ?? 'je taak'
    const important = isImportant(task, block.date)
    if (end - start >= 30 * MIN) {
      out.push({
        key: `checkin:midway:${block.id}:${start}`,
        kind: 'checkin',
        at: start + Math.round((end - start) / 2 / (5 * MIN)) * 5 * MIN,
        title: `Al bezig met ${name}?`,
        body: `Halverwege · gepland ${clock(start)}–${clock(end)}`,
        checkin: { taskId: block.taskId, stage: 'midway', important, task: name }
      })
    }
    out.push({
      key: `checkin:end:${block.id}:${end}`,
      kind: 'checkin',
      at: end,
      title: `${name}: gelukt?`,
      body: `${clock(start)}–${clock(end)} is voorbij${important ? ' · belangrijk' : ''}`,
      checkin: { taskId: block.taskId, stage: 'end', important, task: name }
    })
  }

  const live = events.filter((event) => !event.cancelled && !event.allDay)
  const outbound = new Map(
    live
      .filter((event) => event.kind === 'travel' && event.travelDirection === 'outbound' && event.parentEventId)
      .map((event) => [event.parentEventId!, event])
  )

  for (const event of live) {
    if (event.kind === 'travel') continue
    const travel = outbound.get(event.id)
    const where = event.location ? ` · ${event.location}` : ''

    if (!travel) {
      // One to wrap up, one to go, and one as it starts.
      for (const { minutes, cue } of WARNINGS) {
        out.push({
          key: `appointment:${event.id}:${event.startsAt}:${minutes}`,
          kind: 'appointment',
          at: event.startsAt - minutes * MIN,
          title: event.title,
          body: `${lead(minutes)} · ${clock(event.startsAt)}${where}`,
          cue
        })
      }
      continue
    }

    const leave = travel.startsAt
    out.push({
      key: `gather:${event.id}:${leave}`,
      kind: 'gather',
      at: leave - 30 * MIN,
      title: 'Verzamel je spullen',
      body: `${event.title} om ${clock(event.startsAt)}${where} · vertrek ${clock(leave)}`,
      cue: 'soon30'
    })
    out.push({
      key: `leave:${event.id}:${leave}`,
      kind: 'leave',
      at: leave - 15 * MIN,
      title: 'Over een kwartier weg',
      body: `${event.title} om ${clock(event.startsAt)}${where} · vertrek ${clock(leave)}`,
      cue: 'soon15'
    })
  }

  return out.filter((reminder) => reminder.at >= fromMs && reminder.at < toMs).sort((a, b) => a.at - b.at)
}

// ------------------------------------------------------------------ not done yet

/**
 * Tasks that are not done, said at fixed moments — not only around a planned block, which a
 * task without a block never had (13 Oct 2026: "hij stuurt geen reminders van taken die we
 * nog niet hebben gedaan"):
 *
 *   past its deadline        10:00 and 19:00, every day until it is done or moved
 *   deadline today           09:30 and 17:00
 *   important                09:15, 14, 7, 3 and 1 day before the deadline ("weet je nog")
 *
 * One notification per moment with every task in it, not one each: five overdue tasks are
 * one message. Waiting (blocked) and done tasks say nothing.
 */
const NUDGE_MOMENTS = {
  overdue: [
    { hour: 10, minute: 0 },
    { hour: 19, minute: 0 }
  ],
  today: [
    { hour: 9, minute: 30 },
    { hour: 17, minute: 0 }
  ],
  ahead: { hour: 9, minute: 15 }
}
const AHEAD_DAYS = [14, 7, 3, 1]

/** High priority, or "Belangrijk: ja" in the notes Jarvis keeps. */
export const markedImportant = (task: Pick<Task, 'priority' | 'notes'>): boolean =>
  task.priority === 'high' || /belangrijk:\s*ja/i.test(task.notes ?? '')

const listed = (titles: string[]): string =>
  titles.length <= 3 ? titles.join(', ') : `${titles.slice(0, 3).join(', ')} en ${titles.length - 3} meer`

const shortDate = (day: string): string => {
  const d = fromIsoDate(day)
  return `${['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'][d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}`
}

export function taskNudges(
  tasks: Pick<Task, 'id' | 'title' | 'status' | 'dueDate' | 'priority' | 'notes'>[],
  fromMs: number,
  toMs: number
): Reminder[] {
  const open = tasks.filter((task) => task.dueDate && (task.status === 'open' || task.status === 'in_progress'))
  const out: Reminder[] = []
  const at = (day: string, hour: number, minute: number): number => fromIsoDate(day).getTime() + (hour * 60 + minute) * MIN

  for (let ms = fromIsoDate(toIsoDate(fromMs)).getTime(); ms < toMs; ms += 86_400_000) {
    // Noon, so a clock change never lands on the wrong day.
    const day = toIsoDate(ms + 12 * 3_600_000)
    const overdue = open.filter((task) => task.dueDate! < day)
    const today = open.filter((task) => task.dueDate === day)

    if (overdue.length > 0) {
      for (const { hour, minute } of NUDGE_MOMENTS.overdue) {
        out.push({
          key: `nudge:overdue:${day}:${hour}`,
          kind: 'nudge',
          at: at(day, hour, minute),
          title: overdue.length === 1 ? `Nog niet gedaan: ${overdue[0]!.title}` : `${overdue.length} taken over hun deadline`,
          body: overdue.length === 1 ? `Deadline was ${shortDate(overdue[0]!.dueDate!)}. Doen, of een nieuw moment kiezen.` : listed(overdue.map((task) => task.title))
        })
      }
    }
    if (today.length > 0) {
      for (const { hour, minute } of NUDGE_MOMENTS.today) {
        out.push({
          key: `nudge:today:${day}:${hour}`,
          kind: 'nudge',
          at: at(day, hour, minute),
          title: today.length === 1 ? `Vandaag af: ${today[0]!.title}` : `Vandaag af: ${today.length} taken`,
          body: today.length === 1 ? 'Deadline is vandaag en hij staat nog open.' : listed(today.map((task) => task.title))
        })
      }
    }
    for (const task of open) {
      if (!markedImportant(task)) continue
      const daysLeft = Math.round((fromIsoDate(task.dueDate!).getTime() - fromIsoDate(day).getTime()) / 86_400_000)
      if (!AHEAD_DAYS.includes(daysLeft)) continue
      out.push({
        key: `nudge:ahead:${task.id}:${day}`,
        kind: 'nudge',
        at: at(day, NUDGE_MOMENTS.ahead.hour, NUDGE_MOMENTS.ahead.minute),
        title: `Weet je nog: ${task.title}`,
        body:
          daysLeft === 1
            ? `Morgen deadline (${shortDate(task.dueDate!)}). Wat moet er nog, en heb je alles?`
            : `Over ${daysLeft} dagen deadline (${shortDate(task.dueDate!)}). Staat er tijd voor ingepland?`
      })
    }
  }
  return out.filter((reminder) => reminder.at >= fromMs && reminder.at < toMs).sort((a, b) => a.at - b.at)
}

// ------------------------------------------------------------------ the rest of the nagging

/**
 * What else Hidde asked to be told (26 Oct 2026), beyond deadlines:
 *
 *   no date, for days        11:30 every day: open tasks with no deadline, older than 3 days
 *   own moments              each task's remindAt, exactly then
 *   tomorrow is empty        21:00 on a working evening when tomorrow has no work planned
 *   preparation asked        12:15 every day until answered: "moet je hier nog iets voor doen?"
 */
const UNDATED_AFTER_DAYS = 3

export interface ExtraNudgeInput {
  tasks: Pick<Task, 'id' | 'title' | 'status' | 'dueDate' | 'mustDoDate' | 'createdAt' | 'remindAt' | 'checklist' | 'notes'>[]
  /** Minutes of task blocks planned on a day. */
  plannedMinOn: (day: string) => number
  /** Titles of what is waiting for a preparation answer. */
  prepAsked: string[]
}

export function extraNudges(input: ExtraNudgeInput, fromMs: number, toMs: number): Reminder[] {
  const open = input.tasks.filter((task) => task.status === 'open' || task.status === 'in_progress')
  const out: Reminder[] = []
  const at = (day: string, hour: number, minute: number): number => fromIsoDate(day).getTime() + (hour * 60 + minute) * MIN

  for (let ms = fromIsoDate(toIsoDate(fromMs)).getTime(); ms < toMs; ms += 86_400_000) {
    const day = toIsoDate(ms + 12 * 3_600_000)
    const dayStart = fromIsoDate(day).getTime()

    const undated = open.filter(
      (task) => !task.dueDate && !task.mustDoDate && dayStart - task.createdAt > UNDATED_AFTER_DAYS * 86_400_000
    )
    if (undated.length > 0) {
      out.push({
        key: `nudge:undated:${day}`,
        kind: 'nudge',
        at: at(day, 11, 30),
        title: undated.length === 1 ? `Nog zonder datum: ${undated[0]!.title}` : `${undated.length} taken staan nog zonder datum`,
        body: `${listed(undated.map((task) => task.title))}. Geef ze een dag, of gooi ze weg.`
      })
    }

    if (input.prepAsked.length > 0) {
      out.push({
        key: `nudge:prep:${day}`,
        kind: 'nudge',
        at: at(day, 12, 15),
        title: 'Moet je hier nog iets voor doen?',
        body: `${listed(input.prepAsked)}. Zeg het Jarvis, of zet het bij de taak.`
      })
    }

    // Sunday to Thursday evening: tomorrow is a working day.
    const tomorrow = toIsoDate(dayStart + 36 * 3_600_000)
    const weekday = fromIsoDate(tomorrow).getDay()
    if (weekday >= 1 && weekday <= 5 && input.plannedMinOn(tomorrow) === 0) {
      out.push({
        key: `nudge:tomorrow:${day}`,
        kind: 'nudge',
        at: at(day, 21, 0),
        title: 'Morgen staat nog niks',
        body: 'Plan je dag nu: open Uurwerk of zeg het tegen Jarvis.'
      })
    }
  }

  for (const task of open) {
    for (const moment of task.remindAt) {
      const when = new Date(moment).getTime()
      if (Number.isNaN(when)) continue
      const left = task.checklist.filter((item) => !item.done).map((item) => item.text)
      out.push({
        key: `nudge:own:${task.id}:${moment}`,
        kind: 'nudge',
        at: when,
        title: task.title,
        body: left.length > 0 ? `Nog: ${listed(left)}` : (task.notes?.split('\n')[0] ?? 'Staat nog open.')
      })
    }
  }

  return out.filter((reminder) => reminder.at >= fromMs && reminder.at < toMs).sort((a, b) => a.at - b.at)
}
