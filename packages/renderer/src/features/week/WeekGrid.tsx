import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { Area, CalendarEvent, PlanBlock, TimeSegment } from '@core/contract/types.js'
import { formatDuration, formatMinuteOfDay } from '../../lib/format.js'
import { AREA_COLORS, areaFill, colorFor, type AreaColor } from '../agenda/agenda-model.js'

export type WeekMode = 'plan' | 'actual' | 'compare'

/** The full day, always. Scrolling beats a window that guesses which hours matter. */
const DAY_MIN = 24 * 60
const PX_PER_MIN = 0.85
const GRID_HEIGHT = DAY_MIN * PX_PER_MIN

interface Props {
  days: string[]
  today: string
  mode: WeekMode
  blocks: PlanBlock[]
  segments: TimeSegment[]
  /**
   * Appointments from a connected calendar.
   *
   * Drawn beside the planned blocks rather than instead of them: an afternoon with a meeting
   * in it and two hours planned around the meeting is one picture, not two.
   */
  events: CalendarEvent[]
  areaById: Map<string, Area>
  onPlanDay: (date: string) => void
  onEventClick?: (event: CalendarEvent) => void
  /** Opens the day planner on the block's own day — that is where blocks are editable. */
  onBlockClick?: (block: PlanBlock) => void
  /** Corrects an hour that was already tracked. */
  onSegmentClick?: (segment: TimeSegment) => void
  /** Creates an appointment on the day that was clicked. */
  onAddEvent?: (date: string) => void
  /**
   * Enters hours for time that was never tracked, at the minute that was clicked.
   *
   * Only wired up in the Actual views. Empty space under Plan means "nothing scheduled" and
   * has its own gesture already; empty space under Actual means "the timer was off", and
   * that is exactly the hole this fills.
   */
  onAddTime?: (date: string, startMin: number) => void
}

/** Clicks land on the quarter hour. Nobody remembers starting at 09:07. */
const SNAP_MIN = 15

/**
 * Where an event came from, as a letter rather than a logo.
 *
 * Colour is reserved for the area — that is the invariant the whole app leans on — so the
 * source has to say what it is some other way.
 */
const SOURCE_BADGE: Record<string, string> = {
  outlook: 'O',
  icloud: 'A',
  ics: 'S',
  uurwerk: 'U'
}

const SOURCE_TITLE: Record<string, string> = {
  outlook: 'From Outlook',
  icloud: 'From Apple Calendar',
  ics: 'From a subscribed calendar',
  uurwerk: 'Created in Uurwerk'
}

/**
 * The colour set for an area: the palette's for the system areas, and for an area the user
 * added its own colour as the fill with the page colour as ink.
 */
const colorsOf = (areaId: string | null, areaById: Map<string, Area>): AreaColor => {
  if (areaId && AREA_COLORS[areaId]) return AREA_COLORS[areaId]
  const area = areaId ? areaById.get(areaId) : undefined
  if (!area) return colorFor(null)
  const fill = areaFill(area)
  return { fill, ink: 'var(--color-bg)', tint: `${fill}26`, soft: fill, label: area.name }
}

/**
 * How a plan block is drawn: a task is its area's fill with ink text; a meeting is a
 * commitment, dashed amber; a break is a quiet grey slab; a buffer only an outline.
 */
const blockStyle = (block: PlanBlock, areaById: Map<string, Area>): CSSProperties => {
  if (block.kind === 'meeting') {
    return {
      background: 'var(--color-warn-soft)',
      color: 'var(--color-warn)',
      border: '1.5px dashed var(--color-warn)'
    }
  }
  if (block.kind === 'break') {
    return { background: 'var(--color-input)', color: 'var(--color-text-dim)' }
  }
  if (block.kind === 'buffer') {
    return {
      background: 'transparent',
      color: 'var(--color-text-faint)',
      border: '1.5px dashed var(--color-border-strong)'
    }
  }
  const colors = colorsOf(block.areaId, areaById)
  return { background: colors.fill, color: colors.ink }
}

const minuteOfDay = (ms: number): number => {
  const d = new Date(ms)
  return d.getHours() * 60 + d.getMinutes()
}

const dayOf = (ms: number): string => {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * Seven days, midnight to midnight, scrolled like a calendar.
 *
 * An earlier version fitted the window to whatever had been planned or tracked. It looked
 * tidy on a normal day and produced hour labels past 24:00 on a late one — and it quietly
 * decided which hours were worth showing. A full day that scrolls has neither problem.
 *
 * Green is always what actually happened; a planned block wears its area's colour. In compare
 * mode the two sit side by side in the same column rather than overlapping, because the
 * gap between them is the only thing worth looking at.
 */
export function WeekGrid({
  days,
  today,
  mode,
  blocks,
  segments,
  events,
  areaById,
  onPlanDay,
  onEventClick,
  onBlockClick,
  onSegmentClick,
  onAddEvent,
  onAddTime
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [nowMin, setNowMin] = useState(() => {
    const now = new Date()
    return now.getHours() * 60 + now.getMinutes()
  })

  const showsToday = days.includes(today)

  // The line has to keep up with the clock, but a minute is precise enough for a calendar.
  useEffect(() => {
    const tick = setInterval(() => {
      const now = new Date()
      setNowMin(now.getHours() * 60 + now.getMinutes())
    }, 60_000)
    return () => clearInterval(tick)
  }, [])

  /** Open on the present rather than on midnight, which is never what you meant. */
  useEffect(() => {
    const container = scrollRef.current
    if (!container) return

    const anchorMin = showsToday
      ? nowMin
      : Math.min(
          ...[
            ...blocks.map((block) => block.startMin),
            ...segments.map((segment) => minuteOfDay(segment.startedAt)),
            9 * 60
          ]
        )

    container.scrollTop = Math.max(0, (anchorMin - 90) * PX_PER_MIN)
    // Only on mount and when the week changes — not on every clock tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days[0], showsToday])

  const showPlan = mode === 'plan' || mode === 'compare'
  const showActual = mode === 'actual' || mode === 'compare'
  const half = mode === 'compare'

  const hours = Array.from({ length: 24 }, (_, hour) => hour)

  return (
    <div className="overflow-hidden rounded-[22px] bg-card">
      {/* Day headers stay put while the hours scroll underneath. */}
      <div className="flex gap-1.5 px-3.5 pt-3 pb-2">
        <div className="w-12 shrink-0" />
        <div className="grid min-w-0 flex-1 grid-cols-7 gap-1.5">
          {days.map((date) => {
            const isToday = date === today
            const dayBlocks = blocks.filter((block) => block.date === date)
            const daySegments = segments.filter((segment) => dayOf(segment.startedAt) === date)

            const plannedMin = dayBlocks
              .filter((block) => block.kind === 'task')
              .reduce((sum, block) => sum + (block.endMin - block.startMin), 0)
            const actualMin = daySegments.reduce((sum, segment) => sum + segment.durationMin, 0)
            const weekday = new Date(`${date}T12:00:00`)

            return (
              // A div wrapping two buttons rather than a button containing one: nesting
              // them is invalid, and the browser resolves it by dropping the inner click.
              <div
                key={date}
                className="group relative rounded-[14px] transition-colors hover:bg-card-hover"
              >
                <button
                  onClick={() => onPlanDay(date)}
                  title="Plan this day"
                  className="flex w-full flex-col items-center gap-1 rounded-[14px] px-1 pt-0.5 pb-1.5 text-center"
                >
                  <div
                    className={`text-[11px] font-bold tracking-[0.8px] uppercase ${isToday ? 'text-accent-soft' : 'text-text-faint'}`}
                  >
                    {weekday.toLocaleDateString('en-GB', { weekday: 'short' })}
                  </div>
                  <div
                    className={`rounded-pill px-2 font-display text-[15px] leading-[26px] font-bold ${
                      isToday ? 'bg-accent text-accent-ink' : 'text-text'
                    }`}
                  >
                    {weekday.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                  </div>
                  <div className="font-mono text-[12px] font-semibold tabular-nums">
                    {showPlan && <span className="text-text-dim">{formatDuration(plannedMin)}</span>}
                    {showPlan && showActual && <span className="text-text-faint"> / </span>}
                    {showActual && <span className="text-accent-soft">{formatDuration(actualMin)}</span>}
                  </div>
                </button>

                {onAddEvent && (
                  <button
                    onClick={() => onAddEvent(date)}
                    aria-label={`New appointment on ${date}`}
                    title="New appointment"
                    className="absolute top-0.5 right-0.5 flex h-6 w-6 items-center justify-center rounded-[8px] text-[15px] leading-none font-bold text-text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:bg-input hover:text-text focus:opacity-100"
                  >
                    +
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div ref={scrollRef} className="max-h-[58vh] overflow-y-auto px-3.5 pt-1 pb-3.5">
        <div className="flex gap-1.5">
          <div className="relative w-12 shrink-0" style={{ height: GRID_HEIGHT }}>
            {hours.map((hour) => (
              <span
                key={hour}
                className="absolute right-2 -translate-y-1/2 font-mono text-[12px] font-semibold text-text-faint tabular-nums"
                style={{ top: hour * 60 * PX_PER_MIN }}
              >
                {String(hour).padStart(2, '0')}:00
              </span>
            ))}
          </div>

          <div className="relative grid min-w-0 flex-1 grid-cols-7 gap-1.5">
            {days.map((date) => {
              const isToday = date === today
              const dayBlocks = blocks.filter((block) => block.date === date)
              const daySegments = segments.filter((segment) => dayOf(segment.startedAt) === date)

              return (
                <div
                  key={date}
                  className={`relative rounded-[14px] ${isToday ? 'bg-accent/[0.05]' : ''}`}
                  style={{ height: GRID_HEIGHT }}
                >
                  {hours.map((hour) => (
                    <div
                      key={hour}
                      className={`absolute right-0 left-0 border-t ${hour % 6 === 0 ? 'border-border' : 'border-input'}`}
                      style={{ top: hour * 60 * PX_PER_MIN }}
                    />
                  ))}

                  {/* Painted before the blocks, so anything on top of it still owns its
                      own click. The minute comes from where in the column you pressed. */}
                  {showActual && onAddTime && (
                    <button
                      title="Add hours you did not track"
                      aria-label={`Add untracked hours on ${date}`}
                      className="absolute inset-0 h-full w-full cursor-copy"
                      onClick={(clickEvent) => {
                        const box = clickEvent.currentTarget.getBoundingClientRect()
                        const minute = (clickEvent.clientY - box.top) / PX_PER_MIN
                        const snapped = Math.round(minute / SNAP_MIN) * SNAP_MIN
                        onAddTime(date, Math.max(0, Math.min(DAY_MIN - SNAP_MIN, snapped)))
                      }}
                    />
                  )}

                  {showPlan &&
                    dayBlocks.map((block) => (
                      <button
                        key={block.id}
                        onClick={() => onBlockClick?.(block)}
                        title={`${block.taskTitle ?? block.title} · ${formatMinuteOfDay(block.startMin)}–${formatMinuteOfDay(block.endMin)}${block.explanation ? `\n\n${block.explanation}` : ''}\n\nClick to edit this day's plan.`}
                        className="absolute overflow-hidden rounded-[8px] px-1.5 text-left text-[11px] leading-tight font-bold transition-opacity hover:opacity-85"
                        style={{
                          ...blockStyle(block, areaById),
                          top: block.startMin * PX_PER_MIN + 1,
                          height: Math.max(12, (block.endMin - block.startMin) * PX_PER_MIN - 2),
                          left: 3,
                          right: half ? '50%' : 3
                        }}
                      >
                        <span className="line-clamp-2">{block.taskTitle ?? block.title}</span>
                      </button>
                    ))}

                  {showActual &&
                    daySegments.map((segment) => {
                      const from = minuteOfDay(segment.startedAt)
                      const to = segment.endedAt ? minuteOfDay(segment.endedAt) : nowMin
                      return (
                        <button
                          key={segment.id}
                          onClick={() => onSegmentClick?.(segment)}
                          title={`${segment.taskTitle ?? 'Not assigned'} · ${formatDuration(segment.durationMin)}${
                            segment.attribution === 'manual'
                              ? '\n\nEntered by hand.'
                              : segment.attribution === 'estimated'
                                ? '\n\nA share of a longer stretch, divided afterwards.'
                                : ''
                          }\n\nClick to correct these hours.`}
                          className={`absolute overflow-hidden rounded-[8px] px-1.5 text-left text-[11px] leading-tight font-bold transition-opacity hover:opacity-85
                            ${
                              segment.taskId === null
                                ? 'border-[1.5px] border-dashed border-accent bg-area-stage-tint text-accent-soft'
                                : 'bg-accent text-accent-ink'
                            }
                            ${segment.attribution === 'tracked' ? '' : 'border-l-[3px] border-l-accent-dim'}`}
                          style={{
                            top: from * PX_PER_MIN + 1,
                            height: Math.max(6, (Math.max(to, from + 1) - from) * PX_PER_MIN - 2),
                            left: half ? 'calc(50% + 2px)' : 3,
                            right: 3
                          }}
                        >
                          <span className="line-clamp-2">
                            {segment.taskTitle ?? 'Not assigned'}
                          </span>
                        </button>
                      )
                    })}

                  {/* Appointments, on the right half so a planned block beside a meeting
                      stays legible. Colour is the area; the letter is the source. */}
                  {events
                    .filter((event) => dayOf(event.startsAt) === date)
                    .map((event) => {
                      const area = event.areaId ? areaById.get(event.areaId) : null
                      const colors = area ? colorsOf(area.id, areaById) : null
                      const from = minuteOfDay(event.startsAt)
                      const to = minuteOfDay(event.endsAt)
                      const unclassified = event.classificationStatus !== 'confirmed'
                      const travel = event.kind === 'travel'

                      return (
                        <button
                          key={event.id}
                          onClick={() => onEventClick?.(event)}
                          title={`${event.title}${area ? ` · ${area.name}` : ''}${
                            event.kind === 'travel' ? ' · travel' : ''
                          }\n\n${
                            event.kind === 'travel'
                              ? 'Click to edit the appointment it belongs to.'
                              : 'Click to edit how this is filed.'
                          }`}
                          className={`absolute overflow-hidden rounded-[8px] border-[1.5px] px-1.5 text-left text-[11px] leading-tight font-bold
                            ${unclassified || travel ? 'border-dashed' : 'border-solid'}`}
                          style={{
                            top: from * PX_PER_MIN + 1,
                            height: Math.max(12, (Math.max(to, from + 1) - from) * PX_PER_MIN - 2),
                            left: '50%',
                            right: 3,
                            // An appointment is its area's tint with a rim in the fill. No area
                            // yet means no claim about what this is: neutral until you say
                            // otherwise, never a colour that implies a decision. Travel frames
                            // the appointment: dashed, quiet, on the card.
                            borderColor: travel
                              ? 'var(--color-text-faint)'
                              : colors
                                ? colors.fill
                                : 'var(--color-border-strong)',
                            background: travel ? 'var(--color-card)' : colors ? colors.tint : 'transparent',
                            color: travel ? 'var(--color-text-dim)' : 'var(--color-text)'
                          }}
                        >
                          <span className="flex items-center gap-1">
                            <span
                              title={SOURCE_TITLE[event.origin]}
                              className="shrink-0 rounded-[4px] bg-bg/70 px-1 text-[9px] font-bold text-text-dim"
                            >
                              {SOURCE_BADGE[event.origin] ?? '·'}
                            </span>
                            <span className="line-clamp-2">{event.title}</span>
                          </span>
                        </button>
                      )
                    })}

                  {/* Where you are right now — drawn last so nothing covers it. */}
                  {isToday && (
                    <div
                      className="pointer-events-none absolute right-0 left-0 z-10 flex items-center"
                      style={{ top: nowMin * PX_PER_MIN }}
                    >
                      <span className="-ml-1 h-2.5 w-2.5 shrink-0 rounded-full bg-danger" />
                      <span className="h-0.5 flex-1 bg-danger" />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
