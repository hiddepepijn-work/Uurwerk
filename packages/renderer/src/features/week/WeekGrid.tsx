import { useEffect, useRef, useState } from 'react'
import type { Area, CalendarEvent, PlanBlock, TimeSegment } from '@core/contract/types.js'
import { formatDuration, formatMinuteOfDay } from '../../lib/format.js'

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
 * Green is always what actually happened, blue-grey is always what was planned. In compare
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
    <div className="overflow-hidden rounded-[12px] border border-border">
      {/* Day headers stay put while the hours scroll underneath. */}
      <div className="flex gap-2 border-b border-border bg-card px-3 py-2">
        <div className="w-12 shrink-0" />
        <div className="grid min-w-0 flex-1 grid-cols-7 gap-2">
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
                className={`group relative rounded-[8px] transition-colors hover:bg-card-hover
                  ${isToday ? 'bg-rail-active' : ''}`}
              >
                <button
                  onClick={() => onPlanDay(date)}
                  title="Plan this day"
                  className="w-full rounded-[8px] px-2 py-1.5 text-center"
                >
                  <div className={`text-[13px] font-medium ${isToday ? 'text-accent' : 'text-text'}`}>
                    {weekday.toLocaleDateString('en-GB', { weekday: 'short' })}
                  </div>
                  <div className="text-[11px] text-text-dim">
                    {weekday.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                  </div>
                  <div className="mt-1 font-mono text-[11px] tabular-nums">
                    {showPlan && <span className="text-text-dim">{formatDuration(plannedMin)}</span>}
                    {showPlan && showActual && <span className="text-text-faint"> / </span>}
                    {showActual && <span className="text-accent">{formatDuration(actualMin)}</span>}
                  </div>
                </button>

                {onAddEvent && (
                  <button
                    onClick={() => onAddEvent(date)}
                    aria-label={`New appointment on ${date}`}
                    title="New appointment"
                    className="absolute top-1 right-1 rounded-[6px] px-1.5 text-[13px] leading-none text-text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:bg-card hover:text-text focus:opacity-100"
                  >
                    +
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div ref={scrollRef} className="max-h-[58vh] overflow-y-auto px-3 py-3">
        <div className="flex gap-2">
          <div className="relative w-12 shrink-0" style={{ height: GRID_HEIGHT }}>
            {hours.map((hour) => (
              <span
                key={hour}
                className="absolute right-0 -translate-y-1/2 font-mono text-[11px] text-text-dim tabular-nums"
                style={{ top: hour * 60 * PX_PER_MIN }}
              >
                {String(hour).padStart(2, '0')}:00
              </span>
            ))}
          </div>

          <div className="relative grid min-w-0 flex-1 grid-cols-7 gap-2">
            {days.map((date) => {
              const isToday = date === today
              const dayBlocks = blocks.filter((block) => block.date === date)
              const daySegments = segments.filter((segment) => dayOf(segment.startedAt) === date)

              return (
                <div
                  key={date}
                  className={`relative rounded-[8px] border bg-bg ${isToday ? 'border-accent/30' : 'border-border'}`}
                  style={{ height: GRID_HEIGHT }}
                >
                  {hours.map((hour) => (
                    <div
                      key={hour}
                      className={`absolute right-0 left-0 border-t ${hour % 6 === 0 ? 'border-border' : 'border-border/40'}`}
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
                        className={`absolute overflow-hidden rounded-[4px] border px-1.5 text-left text-[10px] leading-tight transition-opacity hover:opacity-80
                          ${block.kind === 'break' ? 'border-border bg-card text-text-dim' : 'border-block-blue bg-block-blue/70 text-text'}`}
                        style={{
                          top: block.startMin * PX_PER_MIN,
                          height: Math.max(12, (block.endMin - block.startMin) * PX_PER_MIN - 1),
                          left: 2,
                          right: half ? '50%' : 2
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
                          className={`absolute overflow-hidden rounded-[4px] px-1.5 text-left text-[10px] leading-tight transition-opacity hover:opacity-80
                            ${
                              segment.taskId === null
                                ? 'border border-dashed border-accent/60 bg-accent/20 text-text'
                                : 'bg-accent/80 text-[#06210F]'
                            }
                            ${segment.attribution === 'tracked' ? '' : 'border-l-2 border-l-accent'}`}
                          style={{
                            top: from * PX_PER_MIN,
                            height: Math.max(6, (Math.max(to, from + 1) - from) * PX_PER_MIN - 1),
                            left: half ? '50%' : 2,
                            right: 2
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
                      const from = minuteOfDay(event.startsAt)
                      const to = minuteOfDay(event.endsAt)
                      const unclassified = event.classificationStatus !== 'confirmed'

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
                          className={`absolute overflow-hidden rounded-[4px] border px-1.5 text-left text-[10px] leading-tight
                            ${unclassified ? 'border-dashed' : ''}`}
                          style={{
                            top: from * PX_PER_MIN,
                            height: Math.max(12, (Math.max(to, from + 1) - from) * PX_PER_MIN - 1),
                            left: '50%',
                            right: 2,
                            // No area yet means no claim about what this is: neutral until
                            // you say otherwise, never a colour that implies a decision.
                            borderColor: area?.color ?? 'var(--color-border-strong)',
                            background: area ? `${area.color}33` : 'transparent',
                            // Travel is the same work, lighter — it frames the appointment.
                            opacity: event.kind === 'travel' ? 0.7 : 1
                          }}
                        >
                          <span className="flex items-center gap-1">
                            <span
                              title={SOURCE_TITLE[event.origin]}
                              className="shrink-0 rounded-[2px] bg-bg/70 px-1 text-[9px] text-text-dim"
                            >
                              {SOURCE_BADGE[event.origin] ?? '·'}
                            </span>
                            <span className="line-clamp-2 text-text">{event.title}</span>
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
                      <span className="-ml-1 h-2 w-2 shrink-0 rounded-full bg-prio-high" />
                      <span className="h-px flex-1 bg-prio-high" />
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
