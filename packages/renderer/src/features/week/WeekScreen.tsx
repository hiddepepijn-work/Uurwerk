import { useMemo, useState } from 'react'
import { WeekTimeline } from '../agenda/PhoneAgenda.js'
import { agendaFor } from '../agenda/agenda-model.js'
import type { CalendarEvent, TimeSegment } from '@core/contract/types.js'
import { nextWeek, previousWeek, toIsoWeek, weekRange } from '@core/util/time.js'
import { api } from '../../api/client.js'
import { useLiveQuery } from '../../hooks/useLiveQuery.js'
import { useToday } from '../../hooks/useToday.js'
import { Button } from '../../ui/Button.js'
import { StatCard } from '../../ui/StatCard.js'
import { BarChartIcon, CalendarIcon, ClockIcon, TrendingUpIcon } from '../../ui/icons.js'
import { formatDuration } from '../../lib/format.js'
import { DayPlanner } from '../planner/DayPlanner.js'
import { EventClassifier } from '../calendar/EventClassifier.js'
import { EventComposer } from '../calendar/EventComposer.js'
import { StretchEditor, type StretchTarget } from '../attribution/StretchEditor.js'
import { PendingPlans } from './PendingPlans.js'
import { RangePlanner } from './RangePlanner.js'
import { SegmentEditor } from './SegmentEditor.js'
import { WeekGrid, type WeekMode } from './WeekGrid.js'

const MODES: Array<{ id: WeekMode; label: string; hint: string }> = [
  { id: 'plan', label: 'Plan', hint: 'What you intended to do' },
  { id: 'actual', label: 'Actual', hint: 'What you really did' },
  { id: 'compare', label: 'Compare', hint: 'Both, side by side' }
]

/** The header's buttons are a step taller than Button's `sm`: 40px, 14px text. */
const HEADER_BUTTON = 'h-10! px-3.5! text-[14px]!'
const BANNER_BUTTON = 'h-10! px-[18px]! text-[14px]! shrink-0'

/**
 * The week, in three readings.
 *
 * Plan and Actual are deliberately separate views of separate data — plan blocks and time
 * segments never write to each other. Compare is where that separation pays off: the gap
 * between the two is the only honest way to see whether your planning matches your days.
 */
export function WeekScreen() {
  const [week, setWeek] = useState(() => toIsoWeek(Date.now()))
  const [mode, setMode] = useState<WeekMode>('plan')
  const [planningDate, setPlanningDate] = useState<string | null>(null)
  /** null when closed; 1 or 2 for the horizon being planned. */
  const [rangeWeeks, setRangeWeeks] = useState<1 | 2 | null>(null)
  const [editingSegment, setEditingSegment] = useState<TimeSegment | null>(null)
  const [stretch, setStretch] = useState<StretchTarget | null>(null)
  const [composingOn, setComposingOn] = useState<string | null>(null)
  const [reviewingDrafts, setReviewingDrafts] = useState(false)
  const [pushing, setPushing] = useState(false)
  const [pushResult, setPushResult] = useState<string | null>(null)

  /**
   * Writes the week on screen to the Uurwerk calendar in iCloud.
   *
   * Scoped to the week you are looking at rather than everything: pushing a year of plan to
   * a phone calendar is not a feature anybody asked for.
   */
  const sendToPhone = async (): Promise<void> => {
    setPushing(true)
    setPushResult(null)
    try {
      const result = await api.calendar.pushPlan(range.from, range.to)
      const changed = result.created + result.updated + result.removed
      setPushResult(
        changed === 0
          ? `${result.calendarName} was already up to date.`
          : `${result.calendarName}: ${result.created} added, ${result.updated} changed, ${result.removed} removed.`
      )
    } catch (error) {
      setPushResult(error instanceof Error ? error.message : String(error))
    } finally {
      setPushing(false)
    }
  }

  const today = useToday()
  const range = useMemo(() => weekRange(week), [week])

  const { data: blocks } = useLiveQuery((client) => client.plans.week(week), ['planning'], [week])
  const { data: segments } = useLiveQuery(
    (client) => client.tracking.segmentsByWeek(week),
    ['sessions'],
    [week]
  )
  const { data: comparison } = useLiveQuery(
    (client) => client.planning.plannedVsActual(week),
    ['planning', 'sessions'],
    [week]
  )
  const { data: totals } = useLiveQuery(
    (client) => client.tracking.totals(week),
    ['sessions'],
    [week]
  )
  const { data: stats } = useLiveQuery(
    (client) => client.stats.week(week),
    ['sessions', 'planning'],
    [week]
  )
  const { data: areas } = useLiveQuery((client) => client.areas.list(), ['settings'], [])
  const { data: events } = useLiveQuery(
    (client) => client.calendar.eventsInRange(range.startMs, range.endMs),
    ['planning'],
    [week]
  )

  const areaById = useMemo(
    () => new Map((areas ?? []).map((area) => [area.id, area])),
    [areas]
  )

  const agendaDays = useMemo(
    () => range.days.map((day) => ({ date: day, ...agendaFor(day, blocks ?? [], events ?? []) })),
    [range.days.join(), blocks, events] // eslint-disable-line react-hooks/exhaustive-deps
  )
  const nowDate = new Date()
  const nowMinute = nowDate.getHours() * 60 + nowDate.getMinutes()

  const { data: pending, refetch: refetchPending } = useLiveQuery(
    (client) => client.calendar.pending(),
    ['planning'],
    []
  )
  const { data: projects } = useLiveQuery((client) => client.projects.list(), ['settings'], [])
  const { data: workTypes } = useLiveQuery((client) => client.workTypes.list(), ['settings'], [])
  const { data: accounts } = useLiveQuery((client) => client.calendar.accounts(), ['settings'], [])

  const { data: tasks } = useLiveQuery(
    (client) => client.tasks.list({ status: 'active' }),
    ['tasks'],
    []
  )
  const { data: pendingDrafts, refetch: refetchDrafts } = useLiveQuery(
    (client) => client.plans.pending(),
    ['planning'],
    []
  )

  /** Only the ones that actually want a decision; the confident ones filed themselves. */
  const waiting = (pending ?? []).filter((entry) => entry.action !== 'classify')
  const [classifyingId, setClassifyingId] = useState<string | null>(null)

  /**
   * The event being classified, whether or not it was ever waiting for a decision.
   *
   * Reopening a classified event goes through the same dialog, so this looks in the whole
   * week rather than only in the queue — the queue holds what arrived, not what exists.
   */
  const classifying = useMemo(() => {
    if (!classifyingId) return null
    const queued = waiting.find((entry) => entry.event.id === classifyingId)
    if (queued) return { event: queued.event, suggestion: queued.suggestion }

    const known = (events ?? []).find((entry) => entry.id === classifyingId)
    return known ? { event: known, suggestion: null } : null
    // `waiting` is a fresh array every render, so depending on it would recompute forever.
    // The data behind it is `pending`, and that is what actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classifyingId, pending, events])

  /** Travel blocks in view, so reopening an event can show the journey it already has. */
  const travelBlocks = useMemo(
    () => (events ?? []).filter((entry) => entry.kind === 'travel'),
    [events]
  )

  /** A travel block is not classified on its own; the appointment it belongs to is. */
  const openClassifier = (event: CalendarEvent): void => {
    setClassifyingId(event.kind === 'travel' ? (event.parentEventId ?? event.id) : event.id)
  }

  const plannedMin = (blocks ?? [])
    .filter((block) => block.kind === 'task')
    .reduce((sum, block) => sum + (block.endMin - block.startMin), 0)

  const drift = (comparison ?? []).filter((row) => Math.abs(row.deltaMin) >= 15)

  /**
   * Which editor a tracked block opens.
   *
   * A block that is one slice of a divided stretch is not a thing you can sensibly edit on
   * its own — its clock times were never real, and changing "the task of the second slice"
   * is not a sentence anyone means. Those open the stretch editor, which edits the whole
   * afternoon. A lone tracked segment is real on its own and keeps the segment editor,
   * which is where the wrong-task-chosen-live correction belongs.
   */
  const openSegment = (segment: TimeSegment): void => {
    if (segment.attributionGroup !== null) setStretch({ mode: 'edit', id: segment.attributionGroup })
    else setEditingSegment(segment)
  }

  return (
    <div className="p-4 wide:p-8">
      <header className="mb-4 flex flex-col gap-4 pb-1 wide:flex-row wide:items-start wide:justify-between">
        <div className="flex flex-col gap-1.5">
          <h1 className="display-title text-[30px] tracking-[-0.8px] wide:text-[40px] wide:tracking-[-1px]">
            Week
          </h1>
          <p className="text-[15px] text-text-dim">
            {new Date(`${range.from}T12:00:00`).toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'long'
            })}{' '}
            –{' '}
            {new Date(`${range.to}T12:00:00`).toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'long',
              year: 'numeric'
            })}
          </p>
        </div>

        {/* On desktop the mode switch and the week arrows share the top row and the actions
            sit below them; only the visual placement moves, the DOM (and tab) order does not. */}
        <div className="flex flex-wrap items-center gap-3 wide:max-w-[780px] wide:justify-end wide:gap-y-2.5">
          <div className="flex rounded-button bg-card p-1 wide:order-1">
            {MODES.map((option) => (
              <button
                key={option.id}
                onClick={() => setMode(option.id)}
                title={option.hint}
                className={`h-[34px] rounded-[10px] px-4 text-[14px] font-bold transition-colors ${
                  mode === option.id ? 'bg-text text-bg' : 'text-text-dim hover:text-text'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          {/* The two planners that had no way in until now. */}
          <div className="flex flex-wrap gap-2 wide:order-3 wide:basis-full wide:justify-end">
            <Button variant="primary" size="sm" className={HEADER_BUTTON} onClick={() => setRangeWeeks(1)}>
              Plan this week
            </Button>
            <Button variant="secondary" size="sm" className={HEADER_BUTTON} onClick={() => setRangeWeeks(2)}>
              Two weeks
            </Button>
            <Button variant="secondary" size="sm" className={HEADER_BUTTON} onClick={() => setComposingOn(today)}>
              New appointment
            </Button>
            {/* The button behind the same thing clicking empty space in Actual does, because
                a gesture nobody is told about is a gesture nobody finds. */}
            <Button
              variant="secondary"
              size="sm"
              className={HEADER_BUTTON}
              onClick={() => setStretch({ mode: 'add', date: today, startMin: 9 * 60 })}
            >
              Add hours
            </Button>
            {/* Only offered once iCloud is connected: a subscribed link cannot be written to,
                and a button that always fails is worse than no button. */}
            {(accounts ?? []).some((account) => account.provider === 'icloud') && (
              <Button
                variant="secondary"
                size="sm"
                className={HEADER_BUTTON}
                disabled={pushing}
                onClick={() => void sendToPhone()}
              >
                {pushing ? 'Sending…' : 'Send to phone'}
              </Button>
            )}
          </div>

          <div className="flex gap-1 wide:order-2">
            <Button
              variant="secondary"
              size="sm"
              aria-label="Previous week"
              className="h-10! w-10 px-0! text-[16px]!"
              onClick={() => setWeek(previousWeek(week))}
            >
              ←
            </Button>
            <Button variant="secondary" size="sm" className={HEADER_BUTTON} onClick={() => setWeek(toIsoWeek(Date.now()))}>
              This week
            </Button>
            <Button
              variant="secondary"
              size="sm"
              aria-label="Next week"
              className="h-10! w-10 px-0! text-[16px]!"
              onClick={() => setWeek(nextWeek(week))}
            >
              →
            </Button>
          </div>
        </div>
      </header>

      {pushResult && (
        <div className="mb-4 flex items-center justify-between gap-4 rounded-card bg-card py-3.5 pr-4 pl-5 text-[14px] text-text">
          <span>{pushResult}</span>
          <button
            onClick={() => setPushResult(null)}
            className="shrink-0 font-bold text-text-dim transition-colors hover:text-text"
          >
            Dismiss
          </button>
        </div>
      )}

      {(pendingDrafts ?? []).length > 0 && (
        <div className="mb-4 flex items-center justify-between gap-4 rounded-card bg-warn-soft py-3.5 pr-3.5 pl-5 shadow-[inset_0_0_0_1px_rgb(209_165_90/0.35)]">
          <div className="min-w-0">
            <div className="text-[15px] font-bold text-text">
              {pendingDrafts!.length} day{pendingDrafts!.length === 1 ? '' : 's'} planned but never
              accepted
            </div>
            <div className="mt-0.5 text-[13px] text-text-dim">
              A draft counts toward nothing — not this grid, not your totals, not the report.
            </div>
          </div>
          <Button variant="primary" size="sm" className={BANNER_BUTTON} onClick={() => setReviewingDrafts(true)}>
            Review
          </Button>
        </div>
      )}

      {waiting.length > 0 && (
        <div className="mb-4 flex items-center gap-4 rounded-card bg-area-stage-tint py-3.5 pr-3.5 pl-5 shadow-[inset_0_0_0_1px_rgb(93_174_134/0.35)]">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-input bg-accent/[0.18] text-accent-soft">
            <CalendarIcon size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-bold text-text">
              {waiting.length} calendar event{waiting.length === 1 ? '' : 's'} waiting to be
              classified
            </div>
            <div className="mt-0.5 truncate text-[13px] text-text-dim">
              {waiting
                .slice(0, 3)
                .map((entry) => entry.event.title)
                .join(' · ')}
              {waiting.length > 3 ? ' …' : ''}
            </div>
          </div>
          <Button
            variant="primary"
            size="sm"
            className={BANNER_BUTTON}
            onClick={() => setClassifyingId(waiting[0]!.event.id)}
          >
            Classify
          </Button>
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 wide:grid-cols-4">
        <StatCard
          icon={<CalendarIcon size={16} />}
          label="Planned"
          value={formatDuration(plannedMin)}
          sub={`of ${formatDuration(stats?.goalMin ?? 2400)} goal`}
        />
        <StatCard
          icon={<ClockIcon size={16} />}
          label="Tracked"
          value={formatDuration(totals?.totalMin ?? 0)}
          sub={`of ${formatDuration(stats?.goalMin ?? 2400)} goal`}
          progress={{ value: totals?.totalMin ?? 0, max: stats?.goalMin ?? 2400 }}
        />
        <StatCard
          icon={<BarChartIcon size={16} />}
          label="Stage hours"
          value={formatDuration(totals?.stageMin ?? 0)}
          sub={totals && totals.otherMin > 0 ? `${formatDuration(totals.otherMin)} other` : 'all of it'}
        />
        <StatCard
          icon={<TrendingUpIcon size={16} />}
          label="Planned vs actual"
          value={
            plannedMin === 0
              ? '—'
              : `${(totals?.totalMin ?? 0) >= plannedMin ? '+' : '−'}${formatDuration(Math.abs((totals?.totalMin ?? 0) - plannedMin))}`
          }
          sub={`${drift.length} task(s) off by 15m or more`}
        />
      </div>

      {/* Plan is the calendar itself, in the same look as the phone and its widget. Actual
          and Compare keep the grid: they draw tracked hours, which the agenda does not. */}
      {mode === 'plan' ? (
        <WeekTimeline
          days={agendaDays}
          today={today}
          nowMinute={nowMinute}
          onOpenDay={setPlanningDate}
          interactive
          hourPx={44}
          className="h-[max(680px,calc(100vh-400px))] rounded-[22px] bg-card px-3.5 pt-3"
        />
      ) : (
      <WeekGrid
        days={range.days}
        today={today}
        mode={mode}
        blocks={blocks ?? []}
        segments={segments ?? []}
        events={events ?? []}
        areaById={areaById}
        onPlanDay={setPlanningDate}
        // Every appointment opens the classifier now, not only the ones still queued. A
        // decision you cannot revisit is a decision you have to get right first time.
        onEventClick={openClassifier}
        // Blocks are edited where they are draggable: the day planner for their own day.
        onBlockClick={(block) => setPlanningDate(block.date)}
        onSegmentClick={openSegment}
        onAddEvent={setComposingOn}
        onAddTime={(date, startMin) => setStretch({ mode: 'add', date, startMin })}
      />
      )}

      <div className="mt-4 flex flex-wrap items-center gap-x-[18px] gap-y-2 text-[13px] text-text-dim">
        <span className="flex items-center gap-[7px]">
          <span className="h-3 w-3 rounded-[4px] bg-area-school" /> Planned
        </span>
        <span className="flex items-center gap-[7px]">
          <span className="h-3 w-3 rounded-[4px] bg-accent" /> Actually tracked
        </span>
        <span className="flex items-center gap-[7px]">
          <span className="h-[9px] w-[9px] rounded-full bg-danger" /> Now
        </span>
        <span className="text-text-faint">
          Click a day to plan it.
          {mode === 'plan' && ' Click a block to see it, drag it to move it, pull its edge to resize it.'}
          {mode !== 'plan' && ' Click empty space to add hours you did not track.'}
        </span>
      </div>

      {mode === 'compare' && (comparison ?? []).length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 font-display text-[20px] font-bold tracking-[-0.3px]">Where the week drifted</h2>
          <div className="overflow-hidden rounded-card bg-card">
            <table className="w-full text-[14px]">
              <thead className="text-text-faint">
                <tr>
                  <th className="px-4 pt-3.5 pb-2.5 text-left text-[12px] font-bold tracking-[0.6px] uppercase">Task</th>
                  <th className="px-4 pt-3.5 pb-2.5 text-left text-[12px] font-bold tracking-[0.6px] uppercase">Project</th>
                  <th className="px-4 pt-3.5 pb-2.5 text-right text-[12px] font-bold tracking-[0.6px] uppercase">Planned</th>
                  <th className="px-4 pt-3.5 pb-2.5 text-right text-[12px] font-bold tracking-[0.6px] uppercase">Actual</th>
                  <th className="px-4 pt-3.5 pb-2.5 text-right text-[12px] font-bold tracking-[0.6px] uppercase">Difference</th>
                </tr>
              </thead>
              <tbody>
                {(comparison ?? []).map((row) => (
                  <tr key={row.taskId} className="border-t border-border">
                    <td className="px-4 py-2.5 font-semibold text-text">{row.taskTitle}</td>
                    <td className="px-4 py-2.5 text-text-dim">{row.projectName ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-text-dim tabular-nums">
                      {formatDuration(row.plannedMin)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono font-bold text-accent-soft tabular-nums">
                      {formatDuration(row.actualMin)}
                    </td>
                    <td
                      className={`px-4 py-2.5 text-right font-mono tabular-nums ${
                        Math.abs(row.deltaMin) < 15
                          ? 'text-text-faint'
                          : row.deltaMin > 0
                            ? 'text-warn'
                            : 'text-text-dim'
                      }`}
                    >
                      {row.deltaMin === 0
                        ? '—'
                        : `${row.deltaMin > 0 ? '+' : '−'}${formatDuration(Math.abs(row.deltaMin))}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[13px] text-text-faint">
            Work with no planned time was unplanned; planned time with nothing tracked did not
            happen. Both are worth knowing.
          </p>
        </section>
      )}

      {planningDate && (
        <DayPlanner
          date={planningDate}
          open
          onClose={() => setPlanningDate(null)}
        />
      )}

      {rangeWeeks !== null && (
        <RangePlanner open weeks={rangeWeeks} onClose={() => setRangeWeeks(null)} />
      )}

      {classifying && (
        <EventClassifier
          event={classifying.event}
          suggestion={classifying.suggestion}
          areas={areas ?? []}
          projects={projects ?? []}
          workTypes={workTypes ?? []}
          travel={travelBlocks}
          sourceName={accounts?.[0]?.displayName ?? 'Your calendar'}
          onClose={() => setClassifyingId(null)}
          onDone={() => {
            // Straight on to the next one: working through a morning's imports should not
            // mean reopening the same dialog five times. Reopening a single event by hand
            // has no queue behind it, so that case just closes.
            const remaining = waiting.filter((entry) => entry.event.id !== classifying.event.id)
            const wasQueued = waiting.some((entry) => entry.event.id === classifying.event.id)
            setClassifyingId(wasQueued ? (remaining[0]?.event.id ?? null) : null)
            refetchPending()
          }}
        />
      )}

      {stretch && (
        <StretchEditor target={stretch} onClose={() => setStretch(null)} />
      )}

      {editingSegment && (
        <SegmentEditor
          segment={editingSegment}
          tasks={tasks ?? []}
          onClose={() => setEditingSegment(null)}
          onDone={() => setEditingSegment(null)}
        />
      )}

      {composingOn && (
        <EventComposer
          initialDate={composingOn}
          onClose={() => setComposingOn(null)}
          onCreated={(created) => {
            // Straight into the classifier: an appointment with no area registers no hours
            // and blocks no planning, so creating one and stopping there does nothing.
            setComposingOn(null)
            setClassifyingId(created.id)
            refetchPending()
          }}
        />
      )}

      <PendingPlans
        open={reviewingDrafts}
        onClose={() => {
          setReviewingDrafts(false)
          refetchDrafts()
        }}
      />
    </div>
  )
}
