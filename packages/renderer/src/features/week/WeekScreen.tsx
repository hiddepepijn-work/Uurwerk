import { useMemo, useState } from 'react'
import { useCompact } from '../../hooks/useCompact.js'
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

/**
 * The week, in three readings.
 *
 * Plan and Actual are deliberately separate views of separate data — plan blocks and time
 * segments never write to each other. Compare is where that separation pays off: the gap
 * between the two is the only honest way to see whether your planning matches your days.
 */
export function WeekScreen() {
  const [week, setWeek] = useState(() => toIsoWeek(Date.now()))
  const [chosenMode, setMode] = useState<WeekMode>('plan')
  /**
   * On the phone this tab is the calendar and nothing else: no hour tiles, no
   * plan-versus-actual. Hours are the laptop's business; the phone is for seeing the week.
   */
  const compact = useCompact()
  const mode: WeekMode = compact ? 'plan' : chosenMode
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
      <header className="mb-7 flex flex-col gap-4 wide:flex-row wide:items-start wide:justify-between">
        <div>
          <h1 className="text-[32px] leading-tight font-semibold">{compact ? 'Agenda' : 'Week'}</h1>
          <p className="mt-1 text-[14px] text-text-dim">
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

        <div className="flex flex-wrap items-center gap-3">
          <div className="hidden rounded-[10px] border border-border bg-card p-1 wide:flex">
            {MODES.map((option) => (
              <button
                key={option.id}
                onClick={() => setMode(option.id)}
                title={option.hint}
                className={`rounded-[7px] px-3.5 py-1.5 text-[13px] transition-colors ${
                  mode === option.id ? 'bg-rail-active text-accent' : 'text-text-dim hover:text-text'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          {/* The two planners that had no way in until now. */}
          <div className="flex gap-1">
            {!compact && (
              <>
                <Button variant="primary" size="sm" onClick={() => setRangeWeeks(1)}>
                  Plan this week
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setRangeWeeks(2)}>
                  Two weeks
                </Button>
              </>
            )}
            <Button variant="secondary" size="sm" onClick={() => setComposingOn(today)}>
              New appointment
            </Button>
            {/* The button behind the same thing clicking empty space in Actual does, because
                a gesture nobody is told about is a gesture nobody finds. */}
            {!compact && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setStretch({ mode: 'add', date: today, startMin: 9 * 60 })}
              >
                Add hours
              </Button>
            )}
            {/* Only offered once iCloud is connected: a subscribed link cannot be written to,
                and a button that always fails is worse than no button. */}
            {(accounts ?? []).some((account) => account.provider === 'icloud') && (
              <Button
                variant="secondary"
                size="sm"
                disabled={pushing}
                onClick={() => void sendToPhone()}
              >
                {pushing ? 'Sending…' : 'Send to phone'}
              </Button>
            )}
          </div>

          <div className="flex gap-1">
            <Button variant="secondary" size="sm" onClick={() => setWeek(previousWeek(week))}>
              ←
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setWeek(toIsoWeek(Date.now()))}>
              This week
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setWeek(nextWeek(week))}>
              →
            </Button>
          </div>
        </div>
      </header>

      {pushResult && (
        <div className="mb-6 flex items-center justify-between gap-4 rounded-[12px] border border-border bg-card px-5 py-3 text-[13px] text-text">
          <span>{pushResult}</span>
          <button
            onClick={() => setPushResult(null)}
            className="shrink-0 text-text-dim transition-colors hover:text-text"
          >
            Dismiss
          </button>
        </div>
      )}

      {(pendingDrafts ?? []).length > 0 && (
        <div className="mb-6 flex items-center justify-between gap-4 rounded-[12px] border border-prio-med/40 bg-prio-med/10 px-5 py-4">
          <div className="min-w-0">
            <div className="text-[14px] text-text">
              {pendingDrafts!.length} day{pendingDrafts!.length === 1 ? '' : 's'} planned but never
              accepted
            </div>
            <div className="mt-0.5 text-[13px] text-text-dim">
              A draft counts toward nothing — not this grid, not your totals, not the report.
            </div>
          </div>
          <Button variant="primary" size="sm" onClick={() => setReviewingDrafts(true)}>
            Review
          </Button>
        </div>
      )}

      {waiting.length > 0 && (
        <div className="mb-6 flex items-center justify-between gap-4 rounded-[12px] border border-accent/30 bg-rail-active px-5 py-4">
          <div className="min-w-0">
            <div className="text-[14px] text-text">
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
            onClick={() => setClassifyingId(waiting[0]!.event.id)}
          >
            Classify
          </Button>
        </div>
      )}

      <div className="mb-7 hidden grid-cols-4 gap-4 wide:grid">
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

      <div className="mt-5 hidden items-center gap-6 text-[13px] text-text-dim wide:flex">
        <span className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-[3px] border border-block-blue bg-block-blue/70" /> Planned
        </span>
        <span className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-[3px] bg-accent/80" /> Actually tracked
        </span>
        <span className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-prio-high" /> Now
        </span>
        <span className="text-text-faint">
          Click a day to plan it.
          {mode !== 'plan' && ' Click empty space to add hours you did not track.'}
        </span>
      </div>

      {mode === 'compare' && (comparison ?? []).length > 0 && (
        <section className="mt-8">
          <h2 className="mb-4 text-[15px] font-semibold">Where the week drifted</h2>
          <div className="overflow-hidden rounded-[12px] border border-border">
            <table className="w-full text-[13px]">
              <thead className="bg-bg text-text-dim">
                <tr>
                  <th className="px-4 py-2.5 text-left font-medium">Task</th>
                  <th className="px-4 py-2.5 text-left font-medium">Project</th>
                  <th className="px-4 py-2.5 text-right font-medium">Planned</th>
                  <th className="px-4 py-2.5 text-right font-medium">Actual</th>
                  <th className="px-4 py-2.5 text-right font-medium">Difference</th>
                </tr>
              </thead>
              <tbody>
                {(comparison ?? []).map((row) => (
                  <tr key={row.taskId} className="border-t border-border">
                    <td className="px-4 py-2.5 text-text">{row.taskTitle}</td>
                    <td className="px-4 py-2.5 text-text-dim">{row.projectName ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-text-dim tabular-nums">
                      {formatDuration(row.plannedMin)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-accent tabular-nums">
                      {formatDuration(row.actualMin)}
                    </td>
                    <td
                      className={`px-4 py-2.5 text-right font-mono tabular-nums ${
                        Math.abs(row.deltaMin) < 15
                          ? 'text-text-faint'
                          : row.deltaMin > 0
                            ? 'text-prio-med'
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
          <p className="mt-3 text-[12px] text-text-faint">
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
