import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { IsoDate } from '@core/contract/types.js'
import { fromIsoDate, toIsoDate, toIsoWeek, weekRange } from '@core/util/time.js'
import { useLiveQuery } from '../../hooks/useLiveQuery.js'
import { useSlidingThumb } from '../../ui/useSlidingThumb.js'
import { EventComposer } from '../calendar/EventComposer.js'
import { ItemSheet, SlotSheet } from './AgendaSheets.js'
import { agendaFor, colorFor, hhmm, OVERLAY_MIN, type AgendaItem, type AllDayItem } from './agenda-model.js'
import { edgePx } from './drag.js'
import { play } from './motion.js'
import { useTimelineDrag, type DragPreview } from './useTimelineDrag.js'

/**
 * The phone's Agenda tab, in the widget's look: a day timeline as the main view and a
 * smaller week of seven columns beside it. Both scroll through the whole day and open
 * on the present.
 */

type View = 'day' | 'week'

const DAY_HOUR_PX = 60
const WEEK_HOUR_PX = 34
const GUTTER = 44

const WEEKDAYS = ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo']

const addDays = (date: IsoDate, days: number): IsoDate => {
  const next = fromIsoDate(date)
  next.setDate(next.getDate() + days)
  return toIsoDate(next)
}

const nowMinute = (): number => {
  const now = new Date()
  return now.getHours() * 60 + now.getMinutes()
}

export function PhoneAgenda() {
  const today = toIsoDate(Date.now())
  const [view, setView] = useState<View>('day')
  const [date, setDate] = useState<IsoDate>(today)
  const [composing, setComposing] = useState(false)
  const [minute, setMinute] = useState(nowMinute)
  const viewSwitch = useSlidingThumb<HTMLDivElement>(view)

  // The red line moves with the clock.
  useEffect(() => {
    const tick = setInterval(() => setMinute(nowMinute()), 30_000)
    return () => clearInterval(tick)
  }, [])

  const week = toIsoWeek(fromIsoDate(date))
  const range = weekRange(week)
  const { data: blocks } = useLiveQuery((client) => client.plans.week(week), ['planning'], [week])
  const { data: events } = useLiveQuery(
    (client) => client.calendar.eventsInRange(range.startMs, range.endMs),
    ['planning'],
    [week]
  )

  const days = useMemo(
    () =>
      range.days.map((day) => ({ date: day, ...agendaFor(day, blocks ?? [], events ?? []) })),
    [range.days.join(), blocks, events] // eslint-disable-line react-hooks/exhaustive-deps
  )
  const selected = days.find((day) => day.date === date) ?? days[0]!

  const step = view === 'day' ? 1 : 7
  const rawTitle =
    view === 'day'
      ? fromIsoDate(date).toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' })
      : `Week ${week.split('-W')[1]} · ${fromIsoDate(range.from).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })} – ${fromIsoDate(range.to).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })}`
  // "Zaterdag 26 september": a capital for the weekday, never for the month.
  const title = rawTitle.charAt(0).toUpperCase() + rawTitle.slice(1)

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 flex-col gap-3 px-4 pt-4 pb-3">
        <div className="flex items-center gap-2">
          <div ref={viewSwitch.containerRef} className="relative flex rounded-button bg-tabbar p-[3px]">
            {/* The selection slides between Dag and Week instead of jumping. */}
            <span aria-hidden className="rounded-[11px] bg-rail-active" style={viewSwitch.thumbStyle} />
            {(['day', 'week'] as View[]).map((option) => (
              <button
                key={option}
                data-active={view === option}
                onClick={() => setView(option)}
                className={`relative z-[1] h-[38px] rounded-[11px] px-3.5 text-[14px] font-bold transition-colors duration-[250ms] ${
                  view === option ? 'text-accent-soft' : 'text-text-dim'
                }`}
              >
                {option === 'day' ? 'Dag' : 'Week'}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <IconButton label={view === 'day' ? 'Vorige dag' : 'Vorige week'} onClick={() => setDate(addDays(date, -step))}>
              <path d="M15 5l-7 7 7 7" />
            </IconButton>
            <button
              onClick={() => setDate(today)}
              className="h-11 rounded-pill bg-input px-3.5 text-[14px] font-bold text-text"
            >
              Vandaag
            </button>
            <IconButton label={view === 'day' ? 'Volgende dag' : 'Volgende week'} onClick={() => setDate(addDays(date, step))}>
              <path d="M9 5l7 7-7 7" />
            </IconButton>
            <IconButton label="Nieuwe afspraak" onClick={() => setComposing(true)} accent>
              <path d="M12 5v14M5 12h14" />
            </IconButton>
          </div>
        </div>
        <h1 className="display-title text-[28px] leading-[1.1] tracking-[-0.6px]">{title}</h1>
        {view === 'day' && selected.allDay.length > 0 && <AllDayRow items={selected.allDay} />}
      </header>

      {view === 'day' ? (
        <DayTimeline
          key={date}
          date={date}
          items={selected.items}
          nowMinute={date === today ? minute : null}
        />
      ) : (
        <WeekTimeline
          key={week}
          days={days}
          today={today}
          nowMinute={minute}
          onOpenDay={(day) => {
            setDate(day)
            setView('day')
          }}
        />
      )}

      {composing && (
        <EventComposer
          initialDate={date}
          onCreated={() => setComposing(false)}
          onClose={() => setComposing(false)}
        />
      )}
    </div>
  )
}

// ------------------------------------------------------------------ day

/**
 * One day in the widget's look. Shared with the desktop's Today screen.
 *
 * With a `date` it is also where you plan by hand: tap an empty moment to put something
 * there, tap an item to see what it is, and move a task by dragging it — with the mouse by
 * pulling it, on the phone by holding it a moment first (press.ts), so scrolling through the
 * day never moves anything. A mouse also stretches a task by its top or bottom edge, and Esc
 * puts back a drag (useTimelineDrag.ts).
 */
export function DayTimeline({
  items,
  nowMinute,
  date,
  hourPx = DAY_HOUR_PX,
  className = 'min-h-0 flex-1 px-4 pb-6'
}: {
  items: AgendaItem[]
  nowMinute: number | null
  /** The day shown; without it the timeline only shows. */
  date?: IsoDate
  hourPx?: number
  className?: string
}) {
  const scroller = useScrollToNow(hourPx, nowMinute)
  const DAY_HOUR_PX = hourPx
  const area = useRef<HTMLDivElement>(null)
  const [slot, setSlot] = useState<number | null>(null)
  const [opened, setOpened] = useState<AgendaItem | null>(null)
  const { drag, problem, dismissProblem, pointerDown } = useTimelineDrag({
    area,
    scroller,
    hourPx: DAY_HOUR_PX,
    dates: date ? [date] : [],
    enabled: date !== undefined,
    onOpen: setOpened,
    onEmpty: (_, minute) => setSlot(minute)
  })
  const ghost = drag ? ghostOf(drag) : null
  const settled = useSettled(drag)

  return (
    <div ref={scroller} className={`overflow-y-auto ${className}`}>
      <div className="relative" style={{ height: 24 * DAY_HOUR_PX + 12 }}>
        <HourLines hourPx={DAY_HOUR_PX} labels />
        <div
          ref={area}
          className="absolute top-[6px] right-0 bottom-0"
          style={{ left: GUTTER }}
          onPointerDown={date ? (event) => pointerDown(event, null, date) : undefined}
        >
          {items.map((item) => (
            <Block
              key={item.id}
              item={item}
              hourPx={DAY_HOUR_PX}
              detailed
              dimmed={drag?.item.id === item.id}
              settling={settled === item.id}
              onPointerDown={date ? (event) => pointerDown(event, item, date) : undefined}
            />
          ))}
          {ghost && <Block item={ghost} hourPx={DAY_HOUR_PX} detailed lifted />}
          {nowMinute !== null && <NowLine top={(nowMinute / 60) * DAY_HOUR_PX} />}
        </div>
      </div>
      {problem && <ProblemNote text={problem} onDismiss={dismissProblem} />}
      {slot !== null && date && <SlotSheet date={date} minute={slot} onClose={() => setSlot(null)} />}
      {opened && <ItemSheet item={opened} onClose={() => setOpened(null)} />}
    </div>
  )
}

// ----------------------------------------------------------------- week

/**
 * Seven days in the widget's look, smaller. Shared with the desktop's Week screen.
 *
 * On the phone a day column is one big button to that day. `interactive` (the desktop)
 * makes it the day timeline's gestures instead, across the week: click an item to see
 * what it is, drag a task to another time or day, pull its edge to stretch it. A click on
 * an empty moment still opens the day.
 */
export function WeekTimeline({
  days,
  today,
  nowMinute,
  onOpenDay,
  interactive = false,
  hourPx = WEEK_HOUR_PX,
  className = 'min-h-0 flex-1 px-2 pb-4'
}: {
  days: Array<{ date: IsoDate; items: AgendaItem[]; allDay?: AllDayItem[] }>
  today: IsoDate
  nowMinute: number
  onOpenDay: (date: IsoDate) => void
  interactive?: boolean
  hourPx?: number
  className?: string
}) {
  const scroller = useScrollToNow(hourPx, nowMinute)
  const WEEK_HOUR_PX = hourPx
  const area = useRef<HTMLDivElement>(null)
  const [opened, setOpened] = useState<AgendaItem | null>(null)
  const { drag, problem, dismissProblem, pointerDown } = useTimelineDrag({
    area,
    scroller,
    hourPx: WEEK_HOUR_PX,
    dates: days.map((day) => day.date),
    enabled: interactive,
    onOpen: setOpened,
    onEmpty: (date) => onOpenDay(date)
  })
  const ghost = drag ? ghostOf(drag) : null
  const settled = useSettled(drag)

  return (
    <div className={`flex flex-col ${className}`}>
      <div className="flex shrink-0 gap-[3px] pb-2 wide:gap-1.5" style={{ paddingLeft: GUTTER - 8 }}>
        {days.map((day, index) => {
          const isToday = day.date === today
          return (
            <button
              key={day.date}
              onClick={() => onOpenDay(day.date)}
              aria-label={`Open ${day.date}`}
              className="flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-1"
            >
              <span
                className={`text-[11px] font-bold tracking-[0.6px] uppercase wide:tracking-[0.8px] ${
                  isToday ? 'text-accent-soft' : 'text-text-dim'
                }`}
              >
                {WEEKDAYS[index]}
              </span>
              <span
                className={`flex h-7 w-7 items-center justify-center rounded-full font-display text-[15px] font-bold ${
                  isToday ? 'bg-accent text-accent-ink' : 'text-text'
                }`}
              >
                {fromIsoDate(day.date).getDate()}
              </span>
              {/* All-day items under the date, one per line: "Kerstvakantie" and "Kerst" both show. */}
              {day.allDay && day.allDay.length > 0 && (
                <span className="flex w-full flex-col items-center gap-1">
                  {day.allDay.map((item) => (
                    <span
                      key={item.id}
                      className={`max-w-full truncate rounded-pill px-1.5 py-0.5 text-[10px] leading-[14px] font-bold ring-1 wide:px-2.5 wide:py-1 wide:text-[12.5px] wide:leading-4 ${
                        day.allDay!.length > 1 ? MANY_DAY_ITEMS.chip : ONE_DAY_ITEM.chip
                      }`}
                      title={item.title}
                    >
                      {item.title}
                    </span>
                  ))}
                </span>
              )}
            </button>
          )
        })}
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <div className="relative" style={{ height: 24 * WEEK_HOUR_PX + 12 }}>
          <HourLines hourPx={WEEK_HOUR_PX} labels every={2} gutter={GUTTER - 8} />
          <div ref={area} className="absolute top-[6px] right-0 bottom-0 flex gap-[3px] wide:gap-1.5" style={{ left: GUTTER - 8 }}>
            {days.map((day) => {
              const column = `relative h-full min-w-0 flex-1 rounded-[10px] wide:rounded-[14px] ${
                day.allDay && day.allDay.length > 0
                  ? day.allDay.length > 1
                    ? MANY_DAY_ITEMS.column
                    : ONE_DAY_ITEM.column
                  : day.date === today
                    ? 'bg-accent/[0.06]'
                    : 'bg-card/50'
              }`
              const blocks = (
                <>
                  {day.items.map((item) => (
                    <Block
                      key={item.id}
                      item={item}
                      hourPx={WEEK_HOUR_PX}
                      dimmed={drag?.item.id === item.id}
                      settling={settled === item.id}
                      onPointerDown={interactive ? (event) => pointerDown(event, item, day.date) : undefined}
                    />
                  ))}
                  {ghost && drag?.date === day.date && (
                    <>
                      <Block item={ghost} hourPx={WEEK_HOUR_PX} lifted />
                      <DragTime drag={drag} hourPx={WEEK_HOUR_PX} />
                    </>
                  )}
                  {day.date === today && <NowLine top={(nowMinute / 60) * WEEK_HOUR_PX} thin />}
                </>
              )
              return interactive ? (
                <div key={day.date} className={column} onPointerDown={(event) => pointerDown(event, null, day.date)}>
                  {blocks}
                </div>
              ) : (
                <button key={day.date} onClick={() => onOpenDay(day.date)} aria-label={`Open ${day.date}`} className={column}>
                  {blocks}
                </button>
              )
            })}
          </div>
        </div>
      </div>
      {problem && <ProblemNote text={problem} onDismiss={dismissProblem} />}
      {opened && <ItemSheet item={opened} onClose={() => setOpened(null)} />}
    </div>
  )
}

// ---------------------------------------------------------------- parts

/** Opens a timeline an hour before now, or at 08:00 on another day. */
function useScrollToNow(hourPx: number, nowMinute: number | null) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const minute = nowMinute ?? 8 * 60
    ref.current?.scrollTo({ top: Math.max(0, ((minute - 60) / 60) * hourPx) })
    // Only on mount: after that the scroll position is the person's.
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return ref
}

function HourLines({
  hourPx,
  labels,
  every = 1,
  gutter = GUTTER
}: {
  hourPx: number
  labels?: boolean
  every?: number
  gutter?: number
}) {
  return (
    <div className="pointer-events-none absolute inset-0 top-[6px]">
      {Array.from({ length: 25 }, (_, hour) => (
        <div key={hour} className="absolute right-0 left-0 flex items-center" style={{ top: hour * hourPx }}>
          <span
            className={`shrink-0 -translate-y-1/2 pr-2 text-right font-mono text-text-faint ${
              // The phone's week is tight: its labels shrink with it. A roomy week (the desktop) reads larger.
              hourPx >= 40 && every > 1 ? 'text-[12px] font-semibold' : every > 1 ? 'text-[9px] font-bold' : 'text-[11px] font-bold'
            }`}
            style={{ width: gutter }}
          >
            {labels && hour % every === 0 && hour < 24 ? hhmm(hour * 60) : ''}
          </span>
          <span className="h-px flex-1 -translate-y-1/2 bg-input" />
        </div>
      ))}
    </div>
  )
}

/** A picked-up block: a ring in the text colour and a deep shadow under it. */
const LIFT_SHADOW = '0 0 0 2px var(--color-text), 0 12px 28px rgba(0,0,0,0.55)'
const REST_SHADOW = '0 0 0 0 transparent, 0 0 0 transparent'

/**
 * The id of the block that was just let go, for a moment after, so it can settle into its
 * quarter. A cancelled drag (Esc) settles back where it came from the same way.
 */
function useSettled(drag: DragPreview | null): string | null {
  const [settled, setSettled] = useState<string | null>(null)
  const held = useRef<string | null>(null)
  useEffect(() => {
    if (drag) {
      held.current = drag.item.id
      return
    }
    const id = held.current
    if (!id) return
    held.current = null
    setSettled(id)
    const clear = window.setTimeout(() => setSettled(null), 700)
    return () => window.clearTimeout(clear)
  }, [drag])
  return settled
}

function Block({
  item,
  hourPx,
  detailed = false,
  dimmed = false,
  lifted = false,
  settling = false,
  onPointerDown
}: {
  item: AgendaItem
  hourPx: number
  detailed?: boolean
  /** Its ghost is being dragged elsewhere. */
  dimmed?: boolean
  /** The ghost itself, following the pointer. */
  lifted?: boolean
  /** Just let go: it drops from lifted into place with a spring. */
  settling?: boolean
  onPointerDown?: (event: React.PointerEvent) => void
}) {
  const self = useRef<HTMLDivElement>(null)
  // Picked up: it rises out of the timeline rather than appearing lifted.
  useLayoutEffect(() => {
    if (lifted) play(self.current, [{ transform: 'scale(1)', boxShadow: REST_SHADOW, offset: 0 }], { duration: 250, easing: '--ease-out' })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  // Let go: back from lifted to flat, overshooting a touch, so it clicks into its quarter.
  useLayoutEffect(() => {
    if (settling)
      play(self.current, [{ transform: 'scale(1.03)', boxShadow: LIFT_SHADOW, zIndex: 20 }, { transform: 'scale(1)', boxShadow: REST_SHADOW, zIndex: 20 }], {
        duration: 550,
        easing: '--spring-bouncy'
      })
  }, [settling])

  const top = (item.startMin / 60) * hourPx + 1
  // A quarter of an hour is 15 px at day scale: too small to read. Short items get a floor
  // and a single line; they may overhang the next slot, which beats being illegible.
  const minutes = item.overlay ? Math.max(item.endMin - item.startMin, OVERLAY_MIN) : item.endMin - item.startMin
  const height = Math.max((minutes / 60) * hourPx - 3, detailed ? 30 : 8)
  const lane = 100 / item.lanes
  // A clear gap between side-by-side items, so a split reads as a split.
  const gap = item.lanes > 1 ? (detailed ? 8 : 3) : detailed ? 4 : 2
  const position = {
    top,
    height,
    left: `${item.lane * lane}%`,
    width: `calc(${lane * (item.span ?? 1)}% - ${gap}px)`
  }
  const handling = onPointerDown
    ? {
        onPointerDown,
        style: { cursor: item.kind === 'task' ? 'grab' : 'pointer', WebkitTouchCallout: 'none' as const, userSelect: 'none' as const }
      }
    : {}
  const color = colorFor(item.areaId)
  // The strips a mouse stretches a task by (useTimelineDrag reads `data-edge`).
  const edge = onPointerDown && item.kind === 'task' && item.source.type === 'block' ? edgePx(height) : 0

  if (item.kind === 'break') {
    return (
      <div
        className={`pointer-events-none absolute flex items-center gap-2 border-l-[3px] border-dotted border-text-faint text-text-dim ${
          detailed ? 'pl-3 text-[14px] font-bold' : 'pl-1 text-[9px] font-bold'
        }`}
        style={position}
      >
        {detailed && height >= 12 ? 'Pauze' : ''}
      </div>
    )
  }

  // Planned work is filled; appointments and travel are outlined, so what is fixed in your
  // calendar reads differently from what the planner suggested.
  const planned = item.kind === 'task' || item.kind === 'meeting'
  const travel = item.kind === 'travel'
  const coveredPx = item.coveredMin > 0 ? (item.coveredMin / 60) * hourPx + 2 : 0
  // Room for a second line is what is left below any overlay, not the whole block.
  const tall = height - coveredPx >= 44
  // The desktop's week has room to name a block and say when; the phone's week only names it.
  const roomy = !detailed && hourPx >= 40
  const roomyTall = roomy && height >= 36

  return (
    <div
      ref={self}
      onPointerDown={handling.onPointerDown}
      className={`absolute overflow-hidden text-left ${
        detailed
          ? tall
            ? 'flex flex-col gap-0.5 rounded-input px-3 py-2'
            : 'flex items-center rounded-input px-3'
          : roomy
            ? 'flex flex-col gap-px rounded-[10px] px-2 py-1.5'
            : 'rounded-[6px] p-[3px]'
      } ${travel ? 'border-[1.5px] border-dashed' : planned ? '' : 'border-[1.5px]'} ${
        lifted ? 'pointer-events-none' : ''
      }`}
      style={{
        ...position,
        ...handling.style,
        opacity: dimmed ? 0.35 : undefined,
        transform: lifted ? 'scale(1.03)' : undefined,
        transition: 'opacity 150ms ease',
        // Appointments sit above planned work.
        zIndex: lifted ? 20 : item.overlay ? 3 : planned ? 1 : 2,
        paddingTop: coveredPx || undefined,
        boxShadow: lifted ? LIFT_SHADOW : undefined,
        // Tasks are the area's fill with its ink; an appointment is its tint inside a line of
        // the fill (solid, so an overlay hides what it covers); travel is a dashed outline.
        background: planned ? color.fill : travel ? 'transparent' : color.tint,
        borderColor: travel ? 'var(--color-text-faint)' : color.fill,
        color: planned ? color.ink : travel ? 'var(--color-text-dim)' : color.soft
      }}
    >
      <div
        className={`font-bold ${
          detailed
            ? 'truncate text-[14px] leading-[1.2]'
            : roomy
              ? 'truncate text-[12px] leading-[1.2]'
              : 'text-[9px] leading-[1.15] break-words'
        }`}
      >
        {item.title}
        {/* Short items still say when: the whole span when there is room, the start otherwise. */}
        {detailed && !tall && (
          <span className="ml-2 text-[12px] font-semibold tabular-nums opacity-80">
            {item.lanes === 1 || item.span === item.lanes ? `${hhmm(item.startMin)}–${hhmm(item.endMin)}` : hhmm(item.startMin)}
          </span>
        )}
        {roomy && !roomyTall && <span className="ml-1 tabular-nums opacity-80">{hhmm(item.startMin)}</span>}
      </div>
      {detailed && tall && (
        <div className="truncate text-[12px] font-semibold tabular-nums opacity-80">
          {lifted ? `${hhmm(item.startMin)}–${hhmm(item.endMin)}` : item.meta}
        </div>
      )}
      {roomyTall && (
        <div className="truncate text-[11px] font-semibold whitespace-nowrap tabular-nums opacity-[0.78]">
          {lifted ? `${hhmm(item.startMin)}–${hhmm(item.endMin)}` : item.meta}
        </div>
      )}
      {edge > 0 && (
        <>
          <div data-edge="start" className="absolute top-0 right-0 left-0" style={{ height: edge, cursor: 'ns-resize' }} />
          <div data-edge="end" className="absolute right-0 bottom-0 left-0" style={{ height: edge, cursor: 'ns-resize' }} />
        </>
      )}
    </div>
  )
}

/** The dragged block as drawn: where it would land, the whole column wide. */
const ghostOf = (drag: DragPreview): AgendaItem => ({
  ...drag.item,
  date: drag.date,
  startMin: drag.startMin,
  endMin: drag.endMin,
  lane: 0,
  lanes: 1,
  span: 1
})

/** The time a dragged block would get, above it: a week's blocks are too small to say it. */
function DragTime({ drag, hourPx }: { drag: DragPreview; hourPx: number }) {
  return (
    <div
      className="pointer-events-none absolute left-1/2 z-30 -translate-x-1/2 rounded-pill bg-text px-2 py-0.5 font-mono text-[11px] leading-4 font-bold whitespace-nowrap text-bg shadow-[0_6px_18px_rgba(0,0,0,0.5)] wide:px-2.5 wide:py-1 wide:text-[12px]"
      style={{ top: Math.max(0, (drag.startMin / 60) * hourPx - 26) }}
    >
      {hhmm(drag.startMin)}–{hhmm(drag.endMin)}
    </div>
  )
}

/** A move that could not be saved; a click puts it away. */
function ProblemNote({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <button
      onClick={onDismiss}
      className="fixed right-4 bottom-24 left-4 z-40 rounded-card bg-warn-soft px-4 py-3.5 text-left text-[14px] font-semibold text-warn shadow-[0_12px_28px_rgba(0,0,0,0.5)]"
    >
      {text}
    </button>
  )
}

function NowLine({ top, thin = false }: { top: number; thin?: boolean }) {
  return (
    <div className="pointer-events-none absolute right-0 left-0 z-10 flex items-center" style={{ top }}>
      <span
        // A soft ring breathes out of the dot: where you are in the day, at a glance.
        className={`shrink-0 -translate-y-1/2 animate-nowpulse rounded-full bg-danger ${thin ? '-ml-[3px] h-2 w-2' : '-ml-[5px] h-2.5 w-2.5'}`}
      />
      <span className="-ml-px h-0.5 flex-1 -translate-y-1/2 bg-danger" />
    </div>
  )
}

/** The day's all-day items, above its timeline: a birthday, a holiday, "vrij". */
/**
 * All-day items are violet, so they read as "about the day". A day with two or more (a holiday
 * and Christmas inside it) turns a redder shade of violet, so a busy day stands out at a glance.
 */
const ONE_DAY_ITEM = {
  chip: 'bg-area-work-tint text-area-work-soft ring-area-work/50',
  column: 'bg-area-work/[0.11] ring-1 ring-area-work/25 ring-inset',
  pill: 'border-area-work/60 bg-area-work-tint text-area-work-soft',
  dot: 'bg-area-work'
}
const MANY_DAY_ITEMS = {
  chip: 'bg-[#2c1b27] text-[#dba9c9] ring-[#c88ab4]/60',
  column: 'bg-[#c88ab4]/[0.13] ring-1 ring-[#c88ab4]/30 ring-inset',
  pill: 'border-[#c88ab4]/70 bg-[#2c1b27] text-[#dba9c9]',
  dot: 'bg-[#c88ab4]'
}

export function AllDayRow({ items }: { items: AllDayItem[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <span
          key={item.id}
          className={`inline-flex items-center gap-2 rounded-pill border-[1.5px] px-3.5 py-[7px] text-[14px] font-bold wide:text-[15px] ${
            items.length > 1 ? MANY_DAY_ITEMS.pill : ONE_DAY_ITEM.pill
          }`}
        >
          <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${items.length > 1 ? MANY_DAY_ITEMS.dot : ONE_DAY_ITEM.dot}`} />
          {item.title}
        </span>
      ))}
    </div>
  )
}

function IconButton({
  label,
  onClick,
  accent = false,
  children
}: {
  label: string
  onClick: () => void
  accent?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className={`flex h-11 w-11 items-center justify-center rounded-pill ${accent ? 'bg-accent text-accent-ink' : 'bg-input text-text'}`}
    >
      <svg
        width={accent ? 20 : 18}
        height={accent ? 20 : 18}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={accent ? 2.8 : 2.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {children}
      </svg>
    </button>
  )
}
