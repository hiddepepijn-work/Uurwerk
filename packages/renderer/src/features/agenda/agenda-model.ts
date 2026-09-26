/**
 * What the phone's agenda draws: planned blocks and calendar appointments for one day,
 * as one list of positioned items. Shared by the day view, the week view and (later) the
 * home-screen widget, so all three read a day the same way.
 */

import type { CalendarEvent, IsoDate, PlanBlock } from '@core/contract/types.js'
import { fromIsoDate } from '@core/util/time.js'

export type AgendaKind = 'task' | 'meeting' | 'break' | 'appointment' | 'travel'

export interface AgendaItem {
  id: string
  date: IsoDate
  startMin: number
  endMin: number
  title: string
  /** "13:30–15:00 · Stage" and, for appointments, the place. */
  meta: string
  kind: AgendaKind
  areaId: string | null
  /** Side-by-side placement when items overlap: lane index and lane count. */
  lane: number
  lanes: number
}

export interface AllDayItem {
  id: string
  title: string
  areaId: string | null
}

/** One colour per area, told apart by lightness as well as hue. */
export const AREA_COLORS: Record<string, { fill: string; ink: string; label: string }> = {
  stage: { fill: '#3ecf73', ink: '#0c1f13', label: 'Stage' },
  school: { fill: '#6aa7ff', ink: '#0b1a33', label: 'School' },
  personal: { fill: '#f0a14b', ink: '#2b1705', label: 'Privé' },
  work: { fill: '#c9a2ff', ink: '#1e1033', label: 'Werk' }
}
const UNFILED = { fill: '#8d8a94', ink: '#141318', label: 'Overig' }

export const colorFor = (areaId: string | null): { fill: string; ink: string; label: string } =>
  (areaId && AREA_COLORS[areaId]) || UNFILED

export const hhmm = (minute: number): string =>
  `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`

/** The day's items, positioned in lanes so overlapping ones sit side by side. */
export function agendaFor(
  date: IsoDate,
  blocks: PlanBlock[],
  events: CalendarEvent[]
): { items: AgendaItem[]; allDay: AllDayItem[] } {
  const midnight = fromIsoDate(date).getTime()
  const items: Omit<AgendaItem, 'lane' | 'lanes'>[] = []
  const allDay: AllDayItem[] = []

  for (const block of blocks) {
    if (block.date !== date || block.kind === 'buffer') continue
    const title = block.taskTitle ?? block.title ?? (block.kind === 'break' ? 'Pauze' : 'Blok')
    const kind: AgendaKind = block.kind === 'break' ? 'break' : block.kind === 'meeting' ? 'meeting' : 'task'
    items.push({
      id: `block:${block.id}`,
      date,
      startMin: block.startMin,
      endMin: block.endMin,
      title,
      meta: [
        `${hhmm(block.startMin)}–${hhmm(block.endMin)}`,
        block.projectName ?? colorFor(block.areaId).label
      ].join(' · '),
      kind,
      areaId: block.areaId
    })
  }

  for (const event of events) {
    if (event.cancelled) continue
    if (event.allDay) {
      if (event.startsAt < midnight + 86_400_000 && event.endsAt > midnight) {
        allDay.push({ id: event.id, title: event.title, areaId: event.areaId })
      }
      continue
    }
    const start = Math.max(0, Math.round((event.startsAt - midnight) / 60_000))
    const end = Math.min(24 * 60, Math.round((event.endsAt - midnight) / 60_000))
    if (end <= 0 || start >= 24 * 60 || end <= start) continue

    const travel = event.kind === 'travel'
    items.push({
      id: `event:${event.id}`,
      date,
      startMin: start,
      endMin: end,
      // A travel block says when to leave, which is the one thing you look it up for.
      title: travel
        ? event.travelDirection === 'return'
          ? `Terugreis ${hhmm(start)}`
          : `Vertrek ${hhmm(start)}`
        : event.title,
      meta: [`${hhmm(start)}–${hhmm(end)}`, travel ? null : event.location].filter(Boolean).join(' · '),
      kind: travel ? 'travel' : 'appointment',
      areaId: event.areaId
    })
  }

  return { items: placeInLanes(items), allDay }
}

/**
 * Greedy lanes within each cluster of overlapping items. Breaks never take a lane of their
 * own: a pause under an appointment is not worth halving the appointment's width for.
 */
function placeInLanes(items: Omit<AgendaItem, 'lane' | 'lanes'>[]): AgendaItem[] {
  const sorted = [...items].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin)
  const placed: AgendaItem[] = []
  let cluster: AgendaItem[] = []
  let clusterEnd = -1
  let laneEnds: number[] = []

  const close = (): void => {
    const lanes = Math.max(1, laneEnds.length)
    for (const item of cluster) item.lanes = item.kind === 'break' ? 1 : lanes
    cluster = []
    laneEnds = []
  }

  for (const raw of sorted) {
    if (raw.startMin >= clusterEnd) close()
    const item: AgendaItem = { ...raw, lane: 0, lanes: 1 }
    if (item.kind !== 'break') {
      let lane = laneEnds.findIndex((end) => end <= item.startMin)
      if (lane === -1) {
        lane = laneEnds.length
        laneEnds.push(item.endMin)
      } else laneEnds[lane] = item.endMin
      item.lane = lane
    }
    cluster.push(item)
    placed.push(item)
    clusterEnd = Math.max(clusterEnd, item.endMin)
  }
  close()
  return placed
}
