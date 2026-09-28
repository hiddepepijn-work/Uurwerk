/**
 * Free moments for an appointment with someone: "wanneer kan ik met Juul afspreken?".
 *
 * The code does the searching so the model does not have to: appointments (and their travel)
 * are hard, the internship hours count as taken unless asked otherwise, tasks do not (they can
 * move) but are named. The answer is a few options spread over the days, and a message Hidde
 * can send as it is.
 */

import type { TimeTrackerAPI } from '../contract/api.js'
import type { IsoDate } from '../contract/types.js'
import { toIsoWeek } from '../util/time.js'

export interface MeetingTimesInput {
  /** How long the appointment itself lasts. */
  minutes: number
  from?: IsoDate
  to?: IsoDate
  part?: 'ochtend' | 'middag' | 'avond' | null
  /** Travel each way: kept free before and after. */
  travelMinutes?: number
  /** Also during the internship hours (a call during a break, say). */
  duringStage?: boolean
  count?: number
}

export interface MeetingOption {
  date: IsoDate
  /** "di 29/9" */
  label: string
  start: string
  end: string
  /** When to leave, with travel. */
  leaveAt: string | null
  /** Tasks planned at that time: they can move, but he should know. */
  tasksThere: string[]
}

const PARTS = { ochtend: [7 * 60, 12 * 60], middag: [12 * 60, 18 * 60], avond: [18 * 60, 22 * 60 + 30] } as const
const WHOLE_DAY = [8 * 60, 22 * 60 + 30] as const
const STEP = 30
const DAYS = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za']

const pad = (n: number): string => String(n).padStart(2, '0')
const hm = (minute: number): string => `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`
const isoOf = (date: Date): IsoDate => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
const dateOf = (day: IsoDate): Date => new Date(`${day}T00:00:00`)
const labelOf = (day: IsoDate): string => {
  const date = dateOf(day)
  return `${DAYS[date.getDay()]} ${date.getDate()}/${date.getMonth() + 1}`
}

export async function findMeetingTimes(
  api: TimeTrackerAPI,
  input: MeetingTimesInput,
  now = new Date()
): Promise<{ options: MeetingOption[]; message: string | null; note: string | null }> {
  const minutes = Math.round(input.minutes)
  if (!(minutes >= 10 && minutes <= 12 * 60)) throw new Error('Geef een duur tussen tien minuten en twaalf uur.')
  const travel = Math.max(0, Math.round(input.travelMinutes ?? 0))
  const count = Math.min(5, Math.max(1, input.count ?? 3))
  const from = input.from ?? isoOf(now)
  const to = input.to ?? isoOf(new Date(dateOf(from).getTime() + 7 * 86_400_000))
  const [dayStart, dayEnd] = input.part ? PARTS[input.part] : WHOLE_DAY

  const weeks = new Map<string, Awaited<ReturnType<TimeTrackerAPI['availability']['forWeek']>>>()
  const options: MeetingOption[] = []

  for (let day = dateOf(from); isoOf(day) <= to && options.length < count; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
    const iso = isoOf(day)
    const midnight = day.getTime()
    const busy: Array<[number, number]> = []

    for (const event of await api.calendar.eventsInRange(midnight, midnight + 86_400_000)) {
      if (event.cancelled || event.allDay) continue
      busy.push([Math.round((event.startsAt - midnight) / 60_000), Math.round((event.endsAt - midnight) / 60_000)])
    }

    if (!input.duringStage) {
      const week = toIsoWeek(day)
      if (!weeks.has(week)) weeks.set(week, await api.availability.forWeek(week))
      const weekday = ((day.getDay() + 6) % 7) + 1
      const rows = weeks.get(week)!.filter((row) => row.weekday === weekday)
      const row = rows.find((entry) => entry.week !== null) ?? rows[0]
      if (row && row.stageStartMin != null && row.stageEndMin != null) busy.push([row.stageStartMin, row.stageEndMin])
    }

    // Today: not in the past, and not in the next half hour either.
    let earliest = dayStart + travel
    if (iso === isoOf(now)) earliest = Math.max(earliest, Math.ceil((now.getHours() * 60 + now.getMinutes() + 30 + travel) / STEP) * STEP)

    // A moment with nothing planned first; only if the day has none, one where a task would
    // have to move (the model avoided those anyway and then named other times than these).
    const blocks = (await api.plans.day(iso)).blocks.filter((block) => block.kind === 'task')
    let withTask: MeetingOption | null = null
    let clear: MeetingOption | null = null
    for (let start = Math.ceil(earliest / STEP) * STEP; start + minutes + travel <= dayEnd; start += STEP) {
      const from_ = start - travel
      const to_ = start + minutes + travel
      if (busy.some(([a, b]) => a < to_ && b > from_)) continue
      const tasks = blocks.filter((block) => block.startMin < to_ && block.endMin > from_).map((block) => block.taskTitle ?? block.title ?? 'taak')
      const option = { date: iso, label: labelOf(iso), start: hm(start), end: hm(start + minutes), leaveAt: travel > 0 ? hm(start - travel) : null, tasksThere: [...new Set(tasks)] }
      if (tasks.length === 0) {
        clear = option
        break
      }
      withTask ??= option
    }
    const chosen = clear ?? withTask
    if (chosen) options.push(chosen)
  }

  if (options.length === 0) {
    return { options, message: null, note: 'Geen vrij moment in die periode en dat dagdeel. Probeer een langere periode, een ander dagdeel, of ook tijdens stage.' }
  }
  const spoken = options.map((option) => `${option.label} om ${option.start.replace(/^0/, '')}`)
  const list = spoken.length > 1 ? `${spoken.slice(0, -1).join(', ')} of ${spoken[spoken.length - 1]}` : spoken[0]
  return { options, message: `Ik kan ${list}. Wat past jou?`, note: null }
}
