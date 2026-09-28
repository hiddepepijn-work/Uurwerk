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
  /**
   * How many lanes wide it is drawn: it reaches right until a lane that overlaps it is in
   * the way, so an item that only touches a crowded moment is not squeezed for its whole
   * length.
   */
  span: number
  /** What it is in the database: a plan block (with its task) or a calendar event. */
  source: { type: 'block'; blockId: string; taskId: string | null } | { type: 'event'; eventId: string; parentId: string | null }
  /**
   * A short appointment (half an hour or less): drawn at least half an hour tall so it can
   * be read, beside whatever it overlaps.
   */
  overlay: boolean
  /** Kept for the widget's data shape; side-by-side layout never covers anything. */
  coveredMin: number
}

/** How many minutes an overlay is drawn as, at least: readable, whatever its length. */
export const OVERLAY_MIN = 30

export interface AllDayItem {
  id: string
  title: string
  areaId: string | null
}

/**
 * One colour set per area, told apart by lightness as well as hue — the single source for
 * area colours in the UI (styles/tokens.css mirrors it as --color-area-*).
 *
 * fill = a solid block, ink = text on that block, tint = a quiet background behind it,
 * soft = the area's colour as text on a dark surface.
 */
export interface AreaColor {
  fill: string
  ink: string
  tint: string
  soft: string
  label: string
}

export const AREA_COLORS: Record<string, AreaColor> = {
  stage: { fill: '#5DAE86', ink: '#0E1A14', tint: '#1B2721', soft: '#86BFA0', label: 'Stage' },
  school: { fill: '#7F9FD6', ink: '#0B1220', tint: '#182030', soft: '#98AFD8', label: 'School' },
  personal: { fill: '#CF9A63', ink: '#1F1406', tint: '#2A2119', soft: '#D5AA7B', label: 'Privé' },
  work: { fill: '#A997CF', ink: '#120F1A', tint: '#221E2C', soft: '#B3A4D6', label: 'Werk' }
}
const UNFILED: AreaColor = { fill: '#8D8A94', ink: '#141318', tint: '#1F1E24', soft: '#A3A2AB', label: 'Overig' }

export const colorFor = (areaId: string | null): AreaColor =>
  (areaId && AREA_COLORS[areaId]) || UNFILED

/**
 * The colour to draw a database area in. The four system areas get their palette colour —
 * the stored one predates it and is not migrated — and any area the user added keeps the
 * colour it was given.
 */
export const areaFill = (area: { id: string; color: string }): string =>
  AREA_COLORS[area.id]?.fill ?? area.color

export const hhmm = (minute: number): string =>
  `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`

/** The day's items, positioned in lanes so overlapping ones sit side by side. */
export function agendaFor(
  date: IsoDate,
  blocks: PlanBlock[],
  events: CalendarEvent[]
): { items: AgendaItem[]; allDay: AllDayItem[] } {
  const midnight = fromIsoDate(date).getTime()
  const items: Omit<AgendaItem, 'lane' | 'lanes' | 'span' | 'overlay' | 'coveredMin'>[] = []
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
      areaId: block.areaId,
      source: { type: 'block', blockId: block.id, taskId: block.taskId }
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
      areaId: event.areaId,
      source: { type: 'event', eventId: event.id, parentId: event.parentEventId }
    })
  }

  return { items: placeInLanes(items), allDay }
}

/**
 * Greedy lanes within each cluster of overlapping items. Breaks never take a lane of their
 * own: a pause under an appointment is not worth halving the appointment's width for.
 */
function placeInLanes(items: Omit<AgendaItem, 'lane' | 'lanes' | 'span' | 'overlay' | 'coveredMin'>[]): AgendaItem[] {
  const sorted = [...items].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin)
  const placed: AgendaItem[] = []
  let cluster: AgendaItem[] = []
  let clusterEnd = -1
  let laneEnds: number[] = []

  /** Where an item is drawn to: a short appointment reserves its enlarged height. */
  const drawnEnd = (item: AgendaItem): number =>
    item.overlay ? Math.max(item.endMin, item.startMin + OVERLAY_MIN) : item.endMin

  const close = (): void => {
    const lanes = Math.max(1, laneEnds.length)
    for (const item of cluster) {
      item.lanes = item.kind === 'break' ? 1 : lanes
      if (item.kind === 'break') continue
      // Stretch right up to the first lane further along that overlaps it in time.
      const blocking = cluster
        .filter(
          (other) =>
            other !== item &&
            other.kind !== 'break' &&
            other.lane > item.lane &&
            other.startMin < drawnEnd(item) &&
            drawnEnd(other) > item.startMin
        )
        .map((other) => other.lane)
      item.span = (blocking.length > 0 ? Math.min(...blocking) : lanes) - item.lane
    }
    cluster = []
    laneEnds = []
  }

  for (const raw of sorted) {
    if (raw.startMin >= clusterEnd) close()
    const overlay =
      (raw.kind === 'appointment' || raw.kind === 'travel') && raw.endMin - raw.startMin <= OVERLAY_MIN
    const item: AgendaItem = { ...raw, lane: 0, lanes: 1, span: 1, overlay, coveredMin: 0 }
    // Breaks never take a lane. A short appointment does, and reserves the height it is
    // drawn at, so nothing is placed under its enlarged box.
    if (item.kind !== 'break') {
      const drawnEnd = overlay ? Math.max(item.endMin, item.startMin + OVERLAY_MIN) : item.endMin
      let lane = laneEnds.findIndex((end) => end <= item.startMin)
      if (lane === -1) {
        lane = laneEnds.length
        laneEnds.push(drawnEnd)
      } else laneEnds[lane] = drawnEnd
      item.lane = lane
    }
    cluster.push(item)
    placed.push(item)
    clusterEnd = Math.max(
      clusterEnd,
      item.overlay ? Math.max(item.endMin, item.startMin + OVERLAY_MIN) : item.endMin
    )
  }
  close()

  return placed
}
