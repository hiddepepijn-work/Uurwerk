import { useEffect, useMemo, useRef, useState } from 'react'
import type { IsoDate } from '@core/contract/types.js'
import { fromIsoDate, toIsoDate, toIsoWeek, weekRange } from '@core/util/time.js'
import { useLiveQuery } from '../../hooks/useLiveQuery.js'
import { EventComposer } from '../calendar/EventComposer.js'
import { agendaFor, colorFor, hhmm, type AgendaItem, type AllDayItem } from './agenda-model.js'

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
          <div className="flex rounded-[12px] bg-card p-1">
            {(['day', 'week'] as View[]).map((option) => (
              <button
                key={option}
                onClick={() => setView(option)}
                className={`h-9 rounded-[9px] px-4 text-[14px] font-medium ${
                  view === option ? 'bg-rail-active text-accent' : 'text-text-dim'
                }`}
              >
                {option === 'day' ? 'Dag' : 'Week'}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-1">
            <IconButton label={view === 'day' ? 'Vorige dag' : 'Vorige week'} onClick={() => setDate(addDays(date, -step))}>
              <path d="M15 6l-6 6 6 6" />
            </IconButton>
            <button
              onClick={() => setDate(today)}
              className="h-11 rounded-full bg-card px-3.5 text-[13px] font-medium text-text"
            >
              Vandaag
            </button>
            <IconButton label={view === 'day' ? 'Volgende dag' : 'Volgende week'} onClick={() => setDate(addDays(date, step))}>
              <path d="M9 6l6 6-6 6" />
            </IconButton>
            <IconButton label="Nieuwe afspraak" onClick={() => setComposing(true)} accent>
              <path d="M12 5v14M5 12h14" />
            </IconButton>
          </div>
        </div>
        <h1 className="text-[24px] leading-tight font-semibold">{title}</h1>
        {view === 'day' && selected.allDay.length > 0 && <AllDayRow items={selected.allDay} />}
      </header>

      {view === 'day' ? (
        <DayTimeline
          key={date}
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

/** One day in the widget's look. Shared with the desktop's Today screen. */
export function DayTimeline({
  items,
  nowMinute,
  hourPx = DAY_HOUR_PX,
  className = 'min-h-0 flex-1 px-4 pb-6'
}: {
  items: AgendaItem[]
  nowMinute: number | null
  hourPx?: number
  className?: string
}) {
  const scroller = useScrollToNow(hourPx, nowMinute)
  const DAY_HOUR_PX = hourPx

  return (
    <div ref={scroller} className={`overflow-y-auto ${className}`}>
      <div className="relative" style={{ height: 24 * DAY_HOUR_PX + 12 }}>
        <HourLines hourPx={DAY_HOUR_PX} labels />
        <div className="absolute top-[6px] right-0 bottom-0" style={{ left: GUTTER }}>
          {items.map((item) => (
            <Block key={item.id} item={item} hourPx={DAY_HOUR_PX} detailed />
          ))}
          {nowMinute !== null && <NowLine top={(nowMinute / 60) * DAY_HOUR_PX} />}
        </div>
      </div>
    </div>
  )
}

// ----------------------------------------------------------------- week

/** Seven days in the widget's look, smaller. Shared with the desktop's Week screen. */
export function WeekTimeline({
  days,
  today,
  nowMinute,
  onOpenDay,
  hourPx = WEEK_HOUR_PX,
  className = 'min-h-0 flex-1 px-2 pb-4'
}: {
  days: Array<{ date: IsoDate; items: AgendaItem[]; allDay?: AllDayItem[] }>
  today: IsoDate
  nowMinute: number
  onOpenDay: (date: IsoDate) => void
  hourPx?: number
  className?: string
}) {
  const scroller = useScrollToNow(hourPx, nowMinute)
  const WEEK_HOUR_PX = hourPx

  return (
    <div className={`flex flex-col ${className}`}>
      <div className="flex shrink-0 pb-2" style={{ paddingLeft: GUTTER - 8 }}>
        {days.map((day, index) => {
          const isToday = day.date === today
          return (
            <button
              key={day.date}
              onClick={() => onOpenDay(day.date)}
              aria-label={`Open ${day.date}`}
              className="flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5"
            >
              <span className={`text-[11px] uppercase ${isToday ? 'text-accent' : 'text-text-dim'}`}>
                {WEEKDAYS[index]}
              </span>
              <span
                className={`flex h-7 w-7 items-center justify-center rounded-full text-[14px] font-semibold ${
                  isToday ? 'bg-accent text-bg' : 'text-text'
                }`}
              >
                {fromIsoDate(day.date).getDate()}
              </span>
            </button>
          )
        })}
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <div className="relative" style={{ height: 24 * WEEK_HOUR_PX + 12 }}>
          <HourLines hourPx={WEEK_HOUR_PX} labels every={2} gutter={GUTTER - 8} />
          <div className="absolute top-[6px] right-0 bottom-0 flex" style={{ left: GUTTER - 8 }}>
            {days.map((day) => (
              <button
                key={day.date}
                onClick={() => onOpenDay(day.date)}
                aria-label={`Open ${day.date}`}
                className={`relative h-full flex-1 border-l border-border/60 ${day.date === today ? 'bg-accent/5' : ''}`}
              >
                {day.items.map((item) => (
                  <Block key={item.id} item={item} hourPx={WEEK_HOUR_PX} />
                ))}
                {day.date === today && <NowLine top={(nowMinute / 60) * WEEK_HOUR_PX} thin />}
              </button>
            ))}
          </div>
        </div>
      </div>
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
            className="-translate-y-1/2 pr-2 text-right font-mono text-[11px] text-text-faint tabular-nums"
            style={{ width: gutter }}
          >
            {labels && hour % every === 0 && hour < 24 ? hhmm(hour * 60) : ''}
          </span>
          <span className="h-px flex-1 -translate-y-1/2 bg-border/70" />
        </div>
      ))}
    </div>
  )
}

function Block({ item, hourPx, detailed = false }: { item: AgendaItem; hourPx: number; detailed?: boolean }) {
  const top = (item.startMin / 60) * hourPx + 1
  const height = Math.max(((item.endMin - item.startMin) / 60) * hourPx - 3, detailed ? 12 : 6)
  const width = 100 / item.lanes
  const position = { top, height, left: `${item.lane * width}%`, width: `calc(${width}% - ${detailed ? 4 : 2}px)` }
  const color = colorFor(item.areaId)

  if (item.kind === 'break') {
    return (
      <div
        className="absolute flex items-center border-l-2 border-dotted border-border pl-2.5 text-[10px] text-text-faint"
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
  const tall = height >= 40

  return (
    <div
      className={`absolute overflow-hidden text-left ${detailed ? 'rounded-[10px] px-2.5 py-1.5' : 'rounded-[5px] px-1 py-0.5'} ${
        travel ? 'border border-dashed' : planned ? '' : 'border-[1.5px]'
      }`}
      style={{
        ...position,
        background: planned ? color.fill : `${color.fill}26`,
        borderColor: color.fill,
        color: planned ? color.ink : 'var(--color-text, #f4f3f0)'
      }}
    >
      <div
        className={`truncate font-semibold ${detailed ? 'text-[13px] leading-tight' : 'text-[9px] leading-[11px]'}`}
      >
        {item.title}
      </div>
      {detailed && tall && <div className="mt-0.5 truncate text-[11px] opacity-80">{item.meta}</div>}
    </div>
  )
}

function NowLine({ top, thin = false }: { top: number; thin?: boolean }) {
  return (
    <div className="pointer-events-none absolute right-0 left-0 z-10 flex items-center" style={{ top }}>
      {!thin && <span className="-ml-1 h-2 w-2 -translate-y-1/2 rounded-full bg-prio-high" />}
      <span className={`flex-1 -translate-y-1/2 bg-prio-high ${thin ? 'h-px' : 'h-0.5'}`} />
    </div>
  )
}

function AllDayRow({ items }: { items: AllDayItem[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span
          key={item.id}
          className="rounded-full border px-2.5 py-1 text-[12px]"
          style={{ borderColor: colorFor(item.areaId).fill }}
        >
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
      className={`flex h-11 w-11 items-center justify-center rounded-full ${accent ? 'bg-accent text-bg' : 'bg-card text-text'}`}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  )
}
