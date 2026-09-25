import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DayPlan, PlanBlock, Task } from '@core/contract/types.js'
import type { DayProposalDto } from '@core/contract/api.js'
import { defaultStageWindowOn } from '@core/domain/stage-hours.js'
import { fromIsoDate, isoWeekday, toIsoDate, toIsoWeek } from '@core/util/time.js'
import { api } from '../../api/client.js'
import { useLiveQuery } from '../../hooks/useLiveQuery.js'
import { Button } from '../../ui/Button.js'
import { Modal } from '../../ui/Modal.js'
import { TimeField } from '../../ui/TimeField.js'
import { PriorityDot } from '../../ui/PriorityDot.js'
import { CalendarIcon, CheckIcon, PlusIcon, SparkIcon } from '../../ui/icons.js'
import { formatDuration, formatLongDate, formatMinuteOfDay } from '../../lib/format.js'
import { DayGrid } from './DayGrid.js'

const DEFAULT_BLOCK_MIN = 60
const SNAP_MIN = 15
const DAY_END = 24 * 60

/**
 * A sensible working window for a day that has never been planned.
 *
 * Proposing 09:00 when it is already nine in the evening is worse than proposing nothing:
 * you have to correct it before you can do anything. So:
 *
 *   - already tracked time today? start at the first minute you actually worked
 *   - planning today with nothing tracked? start now, rounded down to the quarter
 *   - planning a future day? fall back to a normal morning
 *
 * The end is the start plus your daily goal, clipped to midnight, with a floor of two
 * hours so a late evening still leaves something to plan into.
 */
function proposeHours(
  date: string,
  today: string,
  dailyGoalMin: number,
  firstTrackedMin: number | null
): { startMin: number; endMin: number } {
  if (date !== today) return { startMin: 9 * 60, endMin: 9 * 60 + dailyGoalMin }

  const now = new Date()
  const nowMin = Math.floor((now.getHours() * 60 + now.getMinutes()) / SNAP_MIN) * SNAP_MIN
  const startMin = Math.max(0, Math.min(firstTrackedMin ?? nowMin, nowMin))
  const endMin = Math.min(DAY_END, Math.max(startMin + 120, startMin + dailyGoalMin))

  return { startMin, endMin }
}

interface Props {
  date: string
  open: boolean
  onClose: () => void
}

/**
 * Plan a day by hand.
 *
 * Edits land on a draft, never on the plan currently in force — pressing Accept is what
 * promotes the draft and supersedes the previous version, which keeps the original day
 * intact for the report. Closing without accepting leaves the accepted plan untouched.
 */
export function DayPlanner({ date, open, onClose }: Props) {
  const [plan, setPlan] = useState<DayPlan | null>(null)
  const [startMin, setStartMin] = useState(9 * 60)
  const [endMin, setEndMin] = useState(17 * 60)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [proposal, setProposal] = useState<DayProposalDto | null>(null)
  const [meetingTitle, setMeetingTitle] = useState('')
  // Minutes since midnight, the same unit plan blocks and availability already use.
  const [meetingFrom, setMeetingFrom] = useState(10 * 60)
  const [meetingTo, setMeetingTo] = useState(11 * 60)
  /** True when a plan is in force for this day, which changes what discarding means. */
  const [hasAcceptedPlan, setHasAcceptedPlan] = useState(false)
  const [confirmingClear, setConfirmingClear] = useState(false)

  const { data: tasks } = useLiveQuery(
    (client) => client.tasks.list({ status: 'active' }),
    ['tasks'],
    []
  )

  const reload = useCallback(async (): Promise<void> => {
    const [draft, inForce, settings, segments] = await Promise.all([
      api.plans.draft(date),
      // What the week is actually reading. Discarding the draft falls back to this, so the
      // footer has to know whether that leaves the day empty or unchanged.
      api.plans.day(date),
      api.settings.get(),
      api.tracking.segmentsByDay(date)
    ])
    setPlan(draft)
    setHasAcceptedPlan(inForce.plan !== null && inForce.blocks.length > 0)

    if (draft.availability) {
      // A window you set yourself always wins over anything proposed.
      setStartMin(draft.availability.startMin)
      setEndMin(draft.availability.endMin)
      return
    }

    const firstTracked = segments.length
      ? Math.min(
          ...segments.map((segment) => {
            const started = new Date(segment.startedAt)
            return started.getHours() * 60 + started.getMinutes()
          })
        )
      : null

    const proposed = proposeHours(date, toIsoDate(Date.now()), settings.dailyGoalMin, firstTracked)
    setStartMin(proposed.startMin)
    setEndMin(proposed.endMin)
  }, [date])

  useEffect(() => {
    if (!open) return
    setProblem(null)
    reload().catch((error: unknown) =>
      setProblem(error instanceof Error ? error.message : String(error))
    )
  }, [open, reload])

  // `plans.day`/`plans.draft` already return the day's fixed events alongside the plan, so
  // there is nothing extra to fetch — the planner and the grid read the same list.
  const events = plan?.events ?? []
  const blocks = plan?.blocks ?? []
  const planned = blocks
    .filter((block) => block.kind === 'task')
    .reduce((sum, block) => sum + (block.endMin - block.startMin), 0)
  const available = Math.max(0, endMin - startMin)

  const scheduledTaskIds = new Set(blocks.map((block) => block.taskId).filter(Boolean))
  const unscheduled = useMemo(
    () => (tasks ?? []).filter((task) => !scheduledTaskIds.has(task.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, blocks]
  )

  /** First gap that fits, so adding a task never silently lands on top of another block. */
  const findSlot = (durationMin: number): { start: number; end: number } => {
    const busyRanges = [...blocks]
      .map((block) => ({ from: block.startMin, to: block.endMin }))
      .sort((a, b) => a.from - b.from)

    let cursor = startMin
    for (const range of busyRanges) {
      if (range.from - cursor >= durationMin) break
      cursor = Math.max(cursor, range.to)
    }
    const end = Math.min(cursor + durationMin, endMin)
    return { start: Math.min(cursor, Math.max(startMin, endMin - durationMin)), end }
  }

  const addTask = async (task: Task): Promise<void> => {
    if (!plan?.plan) return
    const duration = task.estimateMin ?? DEFAULT_BLOCK_MIN
    const slot = findSlot(Math.min(duration, available))
    await api.plans.addBlock(plan.plan.id, {
      taskId: task.id,
      areaId: task.areaId,
      date,
      startMin: slot.start,
      endMin: slot.end,
      kind: 'task',
      source: 'manual'
    })
    await reload()
  }

  const addBreak = async (): Promise<void> => {
    if (!plan?.plan) return
    const slot = findSlot(30)
    await api.plans.addBlock(plan.plan.id, {
      date,
      startMin: slot.start,
      endMin: slot.end,
      kind: 'break',
      title: 'Break',
      fixed: true,
      source: 'manual'
    })
    await reload()
  }

  /**
   * A meeting is not a plan block.
   *
   * Blocks belong to a plan and are replaced when the planner runs again; a commitment to
   * be somewhere at eleven survives every replan, so it lives outside the plan entirely and
   * the scheduler treats it as a wall.
   */
  const addMeeting = async (): Promise<void> => {
    if (!meetingTitle.trim()) return
    if (meetingTo <= meetingFrom) {
      setProblem('A meeting has to end after it starts.')
      return
    }

    setBusy(true)
    try {
      await api.availability.addEvent({
        date,
        startMin: meetingFrom,
        endMin: meetingTo,
        title: meetingTitle.trim(),
        kind: 'meeting',
        areaId: null,
        recurring: false
      })
      setMeetingTitle('')
      setProblem(null)
      await reload()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const removeMeeting = async (id: string): Promise<void> => {
    await api.availability.removeEvent(id)
    await reload()
  }

  /**
   * Rebuilds only what has not happened yet.
   *
   * Only offered for today, and only from this minute on: rewriting a morning at four in
   * the afternoon is the behaviour that makes people stop trusting a planner.
   */
  const replanRest = async (): Promise<void> => {
    if (!plan?.plan) return
    setBusy(true)
    try {
      const now = new Date()
      const filled = await api.planner.replanRest(
        plan.plan.id,
        date,
        now.getHours() * 60 + now.getMinutes()
      )
      setPlan(filled)
      setProblem(null)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  /** Throws the working copy away. The plan currently in force is untouched. */
  const discard = async (): Promise<void> => {
    if (!plan?.plan) return
    setBusy(true)
    try {
      await api.plans.discard(plan.plan.id)
      onClose()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Leaves the day with no plan at all.
   *
   * Discarding is not this, and the difference is what made the button look broken: a
   * discarded draft falls back to the plan it branched from, so a day you wanted rid of went
   * on looking exactly as planned as before.
   */
  const clearDay = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.plans.clearDay(date)
      onClose()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const saveHours = async (nextStart: number, nextEnd: number): Promise<void> => {
    if (nextEnd <= nextStart) return
    const stageDefault = defaultStageWindowOn(date)
    setStartMin(nextStart)
    setEndMin(nextEnd)
    await api.availability.save({
      // Stored against this specific week, so changing today does not rewrite your
      // usual pattern for every other Tuesday.
      week: toIsoWeek(fromIsoDate(date)),
      weekday: isoWeekday(date),
      startMin: nextStart,
      endMin: nextEnd,
      allowedAreas: [],
      areaTargets: {},
      enabled: true,
      // Widening the day does not hand the extra hours to the internship: the window you
      // already set for it stays, and only the default fills in when there is none.
      stageStartMin: plan?.availability?.stageStartMin ?? stageDefault?.startMin ?? null,
      stageEndMin: plan?.availability?.stageEndMin ?? stageDefault?.endMin ?? null
    })
  }

  /** Asks the planner to fill the draft. Nothing is accepted until you press Accept. */
  const propose = async (): Promise<void> => {
    if (!plan?.plan) return
    setBusy(true)
    try {
      const result = await api.planner.proposeDay(date)
      setProposal(result)
      const filled = await api.planner.fillDraft(plan.plan.id, date)
      setPlan(filled)
      setProblem(null)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const accept = async (): Promise<void> => {
    if (!plan?.plan) return
    setBusy(true)
    try {
      await api.plans.accept(plan.plan.id)
      onClose()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={1040}
      title="Plan your day"
      subtitle={formatLongDate(fromIsoDate(date))}
      footer={
        confirmingClear ? (
          <>
            <span className="text-[13px] text-prio-high">
              Leave this day with no plan at all? Tracked hours are kept.
            </span>
            <div className="flex gap-3">
              <Button variant="ghost" onClick={() => setConfirmingClear(false)} disabled={busy}>
                Keep the plan
              </Button>
              <Button variant="danger" onClick={() => void clearDay()} disabled={busy}>
                Clear this day
              </Button>
            </div>
          </>
        ) : (
          <>
            <span className="text-[13px] text-text-dim">
              {formatDuration(planned)} planned of {formatDuration(available)} available
              {planned > available && (
                <span className="ml-2 text-prio-med">— more than fits in the day</span>
              )}
            </span>
            <div className="flex gap-3">
              {/* Two different retreats, and conflating them is what made this look broken.
                  Discard drops the edits and falls back to the plan in force; Clear says
                  there should be no plan here at all. The second is only offered when there
                  is something in force to clear — otherwise discarding already empties it. */}
              {hasAcceptedPlan && (
                <Button variant="ghost" onClick={() => setConfirmingClear(true)} disabled={busy}>
                  Clear day
                </Button>
              )}
              <Button variant="ghost" onClick={() => void discard()} disabled={busy || !plan?.plan}>
                {hasAcceptedPlan ? 'Discard changes' : 'Discard draft'}
              </Button>
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="primary"
                icon={<CheckIcon size={15} />}
                onClick={() => void accept()}
                disabled={busy || blocks.length === 0}
              >
                Accept plan
              </Button>
            </div>
          </>
        )
      }
    >
      {problem && (
        <div className="mb-5 rounded-[10px] border border-prio-med/40 bg-prio-med/10 px-4 py-3 text-[13px] text-prio-med">
          {problem}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 wide:grid-cols-[300px_minmax(0,1fr)]">
        {/* ------------------------------------------------------- sidebar */}
        <div className="flex min-h-0 flex-col gap-5">
          <div className="rounded-[12px] border border-border bg-bg p-4">
            <h3 className="mb-3 text-[14px] font-semibold">Working hours today</h3>
            <div className="flex items-center gap-2">
              <TimeField value={startMin} onChange={(next) => void saveHours(next, endMin)} />
              <span className="text-text-dim">to</span>
              {/* A day may legitimately end at midnight; the native input rejected 24:00. */}
              <TimeField
                value={endMin}
                allowEndOfDay
                onChange={(next) => void saveHours(startMin, next)}
              />
            </div>
            <p className="mt-2 text-[12px] text-text-faint">
              {formatDuration(available)} available. Set it to whatever today really is — early,
              late, or a short day.
            </p>
            <Button
              variant="secondary"
              size="sm"
              className="mt-3 w-full"
              icon={<PlusIcon size={14} />}
              onClick={() => void addBreak()}
            >
              Add a break
            </Button>
          </div>

          <div className="rounded-[12px] border border-border bg-bg p-4">
            <h3 className="mb-1 text-[14px] font-semibold">Meetings and appointments</h3>
            <p className="mb-3 text-[12px] leading-relaxed text-text-dim">
              Times you are committed elsewhere. The planner schedules around them and never
              moves them, and they survive every replan.
            </p>

            <input
              value={meetingTitle}
              onChange={(event) => setMeetingTitle(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && void addMeeting()}
              placeholder="Meeting with Margriet"
              className="mb-2 w-full rounded-[8px] border border-border bg-card px-3 py-2 text-[13px] text-text outline-none placeholder:text-text-faint focus:border-accent"
            />

            <div className="flex items-center gap-2">
              <TimeField value={meetingFrom} onChange={setMeetingFrom} />
              <span className="text-text-dim">to</span>
              <TimeField value={meetingTo} onChange={setMeetingTo} />
              <Button
                variant="secondary"
                size="sm"
                className="ml-auto"
                disabled={busy || !meetingTitle.trim()}
                onClick={() => void addMeeting()}
              >
                Add
              </Button>
            </div>

            {events.length > 0 && (
              <ul className="mt-3 flex flex-col gap-1">
                {events.map((event) => (
                  <li
                    key={event.id}
                    className="flex items-center gap-2 rounded-[8px] px-2 py-1.5 text-[12px] hover:bg-card-hover"
                  >
                    <span className="min-w-0 flex-1 truncate text-text">{event.title}</span>
                    <span className="shrink-0 font-mono text-text-dim">
                      {formatMinuteOfDay(event.startMin)}–{formatMinuteOfDay(event.endMin)}
                    </span>
                    <button
                      onClick={() => void removeMeeting(event.id)}
                      title="Remove"
                      className="shrink-0 rounded p-0.5 text-text-faint hover:text-prio-high"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-[12px] border border-accent/30 bg-rail-active p-4">
            <h3 className="mb-1 text-[14px] font-semibold">Let Uurwerk plan it</h3>
            <p className="mb-3 text-[12px] leading-relaxed text-text-dim">
              Fills the free time using deadlines, priorities and dependencies. Anything you
              placed or locked yourself stays where it is, and you can still change everything
              afterwards.
            </p>
            <Button
              variant="primary"
              size="sm"
              className="w-full"
              icon={<SparkIcon size={14} />}
              onClick={() => void propose()}
              disabled={busy}
            >
              Propose a plan
            </Button>

            {/* Only today can have a "rest of the day"; on any other date this would just
                be the same thing as proposing, with a confusing name. */}
            {date === toIsoDate(Date.now()) && (
              <Button
                variant="secondary"
                size="sm"
                className="mt-2 w-full"
                onClick={() => void replanRest()}
                disabled={busy}
              >
                Replan the rest of today
              </Button>
            )}
            {proposal && (
              <p className="mt-2 text-[12px] text-text-dim">
                Planned {formatDuration(proposal.plannedMin)}, kept{' '}
                {formatDuration(proposal.bufferMin)} as buffer.
                {proposal.unplaced.length > 0 && (
                  <> {proposal.unplaced.length} task(s) did not fit.</>
                )}
              </p>
            )}
          </div>

          <div className="flex min-h-0 flex-1 flex-col rounded-[12px] border border-border bg-bg p-4">
            <h3 className="mb-3 text-[14px] font-semibold">
              Not planned yet
              <span className="ml-2 text-[12px] font-normal text-text-dim">
                {unscheduled.length}
              </span>
            </h3>

            <div className="-mr-2 min-h-0 flex-1 overflow-y-auto pr-2">
              {unscheduled.length === 0 ? (
                <p className="text-[13px] text-text-faint">
                  Everything on your list is in the plan.
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {unscheduled.map((task) => (
                    <li key={task.id}>
                      <button
                        onClick={() => void addTask(task)}
                        className="flex w-full items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-left transition-colors hover:bg-card-hover"
                      >
                        <PriorityDot priority={task.priority} />
                        <span className="min-w-0 flex-1 truncate text-[13px] text-text">
                          {task.title}
                        </span>
                        <span className="shrink-0 font-mono text-[11px] text-text-dim">
                          {task.estimateMin ? formatDuration(task.estimateMin) : '—'}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>

        {/* ---------------------------------------------------------- grid */}
        <div className="min-w-0">
          <div className="mb-3 flex items-center gap-2 text-[12px] text-text-dim">
            <CalendarIcon size={14} />
            Drag a block to move it, pull its bottom edge to change how long it takes.
          </div>

          <div className="max-h-[52vh] overflow-y-auto pr-1">
            <DayGrid
              startMin={startMin}
              endMin={endMin}
              blocks={blocks}
              events={events}
              onRemoveEvent={(id) => void removeMeeting(id)}
              onChange={(id, from, to) => {
                // Optimistic: the grid already shows the new position, so re-reading
                // before the write lands would make the block jump back and forth.
                setPlan((current) =>
                  current
                    ? {
                        ...current,
                        blocks: current.blocks.map((block) =>
                          block.id === id ? { ...block, startMin: from, endMin: to } : block
                        )
                      }
                    : current
                )
                void api.plans.updateBlock(id, { startMin: from, endMin: to })
              }}
              onRemove={(id) => {
                void api.plans.removeBlock(id).then(reload)
              }}
              onToggleLock={(block: PlanBlock) => {
                void api.plans.updateBlock(block.id, { locked: !block.locked }).then(reload)
              }}
            />
          </div>
        </div>
      </div>
    </Modal>
  )
}
