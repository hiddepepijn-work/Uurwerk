/**
 * The reminders that come before things start: the same list for the phone (local
 * notifications) and the laptop (desktop notifications), so both say the same thing at
 * the same moment.
 *
 *   planned task             15 min before   "Over 15 min: <task>"
 *   appointment, no travel   30 and 15 min before   "Over 30 min" / "Over 15 min: <appointment>"
 *   planned task, halfway    "Ben je al bezig met <task>?"   (Ja, bezig / Nog niet)
 *   planned task, at its end "Is <task> gelukt?"            (Gelukt / Nog niet af)
 *   appointment with travel  30 min before leaving   "Verzamel je spullen"
 *                            15 min before leaving   "Hidde, lukt het?" — spoken
 *
 * Leaving is when the outbound travel block starts. Nothing here knows about platforms.
 */

import type { CalendarEvent, PlanBlock, Task } from '../contract/types.js'
import { fromIsoDate } from '../util/time.js'

export type ReminderKind = 'task' | 'appointment' | 'gather' | 'leave' | 'checkin'

export interface Reminder {
  /** Stable across recomputes, so a reschedule replaces rather than duplicates. */
  key: string
  kind: ReminderKind
  at: number
  title: string
  body: string
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
    out.push({
      key: `task:${block.id}:${start}`,
      kind: 'task',
      at: start - 15 * MIN,
      title: `Over 15 min: ${block.taskTitle ?? block.title ?? 'volgende taak'}`,
      body: `${clock(start)}–${clock(end)}${block.projectName ? ` · ${block.projectName}` : ''}`
    })

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
        title: `Ben je al bezig met ${name}?`,
        body: `Gepland ${clock(start)}–${clock(end)}.`,
        checkin: { taskId: block.taskId, stage: 'midway', important, task: name }
      })
    }
    out.push({
      key: `checkin:end:${block.id}:${end}`,
      kind: 'checkin',
      at: end,
      title: `Is ${name} gelukt?`,
      body: important ? 'Belangrijk. Gelukt, of nog niet af?' : 'Gelukt, of nog niet af?',
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
      // Two warnings, like a departure: one to wrap up, one to go.
      for (const minutes of [30, 15]) {
        out.push({
          key: `appointment:${event.id}:${event.startsAt}:${minutes}`,
          kind: 'appointment',
          at: event.startsAt - minutes * MIN,
          title: `Over ${minutes} min: ${event.title}`,
          body: `${clock(event.startsAt)}${where}`
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
      body: `${event.title} om ${clock(event.startsAt)}${where}. Om ${clock(leave)} moet je weg.`
    })
    out.push({
      key: `leave:${event.id}:${leave}`,
      kind: 'leave',
      at: leave - 15 * MIN,
      title: 'Hidde, lukt het?',
      body: `Over een kwartier moet je in de auto zitten. ${event.title} om ${clock(event.startsAt)}.`
    })
  }

  return out.filter((reminder) => reminder.at >= fromMs && reminder.at < toMs).sort((a, b) => a.at - b.at)
}
