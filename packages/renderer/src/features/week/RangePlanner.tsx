import { useEffect, useMemo, useState } from 'react'
import type { Availability, RecurringCommitment, Shortfall } from '@core/contract/types.js'
import type { RangeProposalDto } from '@core/contract/api.js'
import { defaultStageWindowForWeekday } from '@core/domain/stage-hours.js'
import { addDays, fromIsoDate, nextWeek, toIsoDate, toIsoWeek, weekRange } from '@core/util/time.js'
import { api } from '../../api/client.js'
import { Button } from '../../ui/Button.js'
import { Modal } from '../../ui/Modal.js'
import { TimeField } from '../../ui/TimeField.js'
import { formatDuration } from '../../lib/format.js'

const WEEKDAYS = [
  { weekday: 1, label: 'Monday' },
  { weekday: 2, label: 'Tuesday' },
  { weekday: 3, label: 'Wednesday' },
  { weekday: 4, label: 'Thursday' },
  { weekday: 5, label: 'Friday' },
  { weekday: 6, label: 'Saturday' },
  { weekday: 7, label: 'Sunday' }
]

/**
 * The internship window that travels along with a save of the working hours.
 *
 * Widening a day to ten at night says you are willing to work until ten. It does not say
 * the internship runs until ten, and quietly stretching it would put internship blocks in
 * the evening and internship hours in a report that nobody worked. So an existing window is
 * carried over untouched, and only a day that has never had one falls back to the default.
 */
function stagePatch(
  patch: Partial<Availability>,
  current: Availability | undefined,
  weekday: number
): Pick<Availability, 'stageStartMin' | 'stageEndMin'> {
  const fallback = defaultStageWindowForWeekday(weekday)
  return {
    stageStartMin:
      patch.stageStartMin !== undefined
        ? patch.stageStartMin
        : (current?.stageStartMin ?? fallback?.startMin ?? null),
    stageEndMin:
      patch.stageEndMin !== undefined
        ? patch.stageEndMin
        : (current?.stageEndMin ?? fallback?.endMin ?? null)
  }
}

/**
 * The internship hours of one day, under its working hours.
 *
 * Two rows rather than one, because they are two different statements. The top row is when
 * you are willing to work; this one is which part of that the internship gets. Unticked
 * means the day has no internship hours at all — a Saturday, or a day of classes — and the
 * planner will then keep internship work off it entirely rather than squeezing it in.
 */
function StageHours({
  day,
  weekday,
  onSave
}: {
  day: Availability
  weekday: number
  onSave: (patch: Partial<Availability>) => void
}) {
  const fallback = defaultStageWindowForWeekday(weekday)
  const has = day.stageStartMin !== null && day.stageEndMin !== null

  return (
    <div className="ml-6 flex items-center gap-1.5">
      <input
        type="checkbox"
        checked={has}
        onChange={(event) =>
          onSave(
            event.target.checked
              ? {
                  stageStartMin: fallback?.startMin ?? day.startMin,
                  stageEndMin: fallback?.endMin ?? day.endMin
                }
              : { stageStartMin: null, stageEndMin: null }
          )
        }
        className="accent-accent"
      />
      <span className={`w-[52px] shrink-0 text-[11px] ${has ? 'text-text-dim' : 'text-text-faint'}`}>
        Stage
      </span>
      {has && (
        <>
          <TimeField
            value={day.stageStartMin!}
            onChange={(next) => onSave({ stageStartMin: next })}
          />
          <span className="text-text-faint">–</span>
          <TimeField
            value={day.stageEndMin!}
            allowEndOfDay
            onChange={(next) => onSave({ stageEndMin: next })}
          />
        </>
      )}
    </div>
  )
}

/**
 * Planning a week or a fortnight in one go.
 *
 * Three things in one dialog, in the order they have to happen: when you can work, what is
 * already spoken for, and only then what Uurwerk proposes to do with what is left.
 *
 * The order is not a layout choice. A day with no working hours set is not a working day —
 * that is what stops the range planner inventing Saturdays — so a plan made before the hours
 * exist would come back empty and look broken.
 *
 * Nothing is written to your calendar until you press Accept: `proposeRange` computes and
 * returns, and the proposal on screen is the whole of what Accept will do. Accepting then
 * writes and promotes one plan per day, which is what puts the week in the grid.
 */
export function RangePlanner({
  open,
  onClose,
  weeks
}: {
  open: boolean
  onClose: () => void
  /** One or two. Beyond a fortnight a plan is fiction. */
  weeks: 1 | 2
}) {
  const [byWeek, setByWeek] = useState<Record<string, Availability[]>>({})
  const [commitments, setCommitments] = useState<RecurringCommitment[]>([])
  const [proposal, setProposal] = useState<RangeProposalDto | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [accepted, setAccepted] = useState(false)
  const [editing, setEditing] = useState<'range' | 'pattern'>('range')

  const from = toIsoDate(Date.now())

  /**
   * The horizon ends on a Sunday, never mid-week.
   *
   * Counting fourteen days forward from a Friday stopped on the Thursday after next, which
   * cuts a week in half — you plan a fortnight and the last week arrives already truncated,
   * with the weekend it was supposed to contain sitting outside the range.
   *
   * So the two buttons mean what their labels say: "this week" is the rest of the week you
   * are in, and "two weeks" is that plus the two whole weeks after it.
   */
  const to = useMemo(() => {
    let week = toIsoWeek(Date.now())
    if (weeks > 1) for (let index = 0; index < weeks; index++) week = nextWeek(week)
    return weekRange(week).to
  }, [weeks])

  /** Every date in the range, which is what the hours are actually set against. */
  const days = useMemo(() => {
    const out: string[] = []
    for (
      let cursor = fromIsoDate(from).getTime();
      cursor <= fromIsoDate(to).getTime();
      cursor = addDays(cursor, 1).getTime()
    ) {
      out.push(toIsoDate(cursor))
    }
    return out
  }, [from, to])

  const weekKeys = useMemo(
    () => [...new Set(days.map((date) => toIsoWeek(fromIsoDate(date))))],
    [days]
  )

  const reload = async (): Promise<void> => {
    const [weekRows, standing] = await Promise.all([
      Promise.all(weekKeys.map(async (key) => [key, await api.availability.forWeek(key)] as const)),
      api.commitments.list()
    ])
    setByWeek(Object.fromEntries(weekRows))
    setCommitments(standing)
  }

  useEffect(() => {
    if (!open) return
    setProposal(null)
    setAccepted(false)
    setProblem(null)
    void reload().catch((error: unknown) =>
      setProblem(error instanceof Error ? error.message : String(error))
    )
    // reload depends only on the week keys, which are derived from `weeks`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, weeks])

  /**
   * The hours in force on one date.
   *
   * `forWeek` already merges: a row written for that specific week wins, and the recurring
   * pattern fills in everywhere else. So this is the answer the planner will use, and
   * whether it came from an override is readable from `row.week`.
   */
  const hoursOn = (date: string): Availability | undefined =>
    byWeek[toIsoWeek(fromIsoDate(date))]?.find((row) => row.weekday === weekdayOf(date))

  const patternFor = (weekday: number): Availability | undefined =>
    byWeek[weekKeys[0] ?? '']?.find((row) => row.weekday === weekday)

  /**
   * Saves the hours for one actual date, as an override on that week.
   *
   * The recurring pattern says what a normal Monday looks like; this says what *this*
   * Monday looks like. Both are needed — a fortnight where every day is the same is not a
   * fortnight anyone recognises — and the week-specific row is the one the planner prefers.
   */
  const saveDate = async (date: string, patch: Partial<Availability>): Promise<void> => {
    const current = hoursOn(date)
    await api.availability.save({
      week: toIsoWeek(fromIsoDate(date)),
      weekday: weekdayOf(date),
      startMin: patch.startMin ?? current?.startMin ?? 9 * 60,
      endMin: patch.endMin ?? current?.endMin ?? 17 * 60,
      allowedAreas: current?.allowedAreas ?? [],
      areaTargets: current?.areaTargets ?? {},
      enabled: patch.enabled ?? current?.enabled ?? true,
      ...stagePatch(patch, current, weekdayOf(date))
    })
    await reload()
    // The plan on screen was made against the old hours; it is no longer what you would get.
    setProposal(null)
  }

  /** The same, for the recurring pattern: `week: null` is what makes it "my normal week". */
  const savePattern = async (weekday: number, patch: Partial<Availability>): Promise<void> => {
    const current = patternFor(weekday)
    await api.availability.save({
      week: null,
      weekday,
      startMin: patch.startMin ?? current?.startMin ?? 9 * 60,
      endMin: patch.endMin ?? current?.endMin ?? 17 * 60,
      allowedAreas: current?.allowedAreas ?? [],
      areaTargets: current?.areaTargets ?? {},
      enabled: patch.enabled ?? current?.enabled ?? true,
      ...stagePatch(patch, current, weekday)
    })
    await reload()
    setProposal(null)
  }

  /**
   * Today is planned from now on, not from nine this morning.
   *
   * Asking for a plan at four in the afternoon and being handed one that starts at nine is
   * the behaviour that makes people stop pressing the button.
   */
  const options = useMemo(() => {
    const now = new Date()
    return { fromMin: Math.ceil((now.getHours() * 60 + now.getMinutes()) / 15) * 15 }
  }, [])

  const propose = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      setProposal(await api.planner.proposeRange(from, to, options))
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const accept = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.planner.applyRange(from, to, options)
      setAccepted(true)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  /** Moving a deadline to the date the work can actually be finished. */
  const moveDeadline = async (shortfall: Shortfall): Promise<void> => {
    if (!shortfall.earliestFinishDate) return
    await api.tasks.update(shortfall.taskId, { dueDate: shortfall.earliestFinishDate })
    setProposal(null)
    await propose()
  }

  const plannedDays = new Set((proposal?.blocks ?? []).map((block) => block.date))

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={900}
      title={weeks === 1 ? 'Plan the rest of this week' : 'Plan the next two weeks'}
      subtitle={`${longRange(from, to)} · ${days.length} days. Today is planned from now on, and nothing is added until you accept it.`}
      footer={
        <>
          <span className="text-[13px] text-text-dim">
            {proposal
              ? `${formatDuration(proposal.plannedMin)} planned across ${plannedDays.size} day${plannedDays.size === 1 ? '' : 's'}, of ${formatDuration(proposal.availableMin)} available`
              : 'Set your hours, then ask for a plan.'}
          </span>
          <div className="flex gap-3">
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              {accepted ? 'Close' : 'Cancel'}
            </Button>
            {proposal && !accepted && (
              <Button
                variant="primary"
                onClick={() => void accept()}
                disabled={busy || proposal.blocks.length === 0}
              >
                Accept plan
              </Button>
            )}
            {!proposal && (
              <Button variant="primary" onClick={() => void propose()} disabled={busy}>
                Propose a plan
              </Button>
            )}
          </div>
        </>
      }
    >
      {problem && (
        <div className="mb-5 rounded-[10px] border border-prio-med/40 bg-prio-med/10 px-4 py-3 text-[13px] text-prio-med">
          {problem}
        </div>
      )}

      {accepted && (
        <div className="mb-5 rounded-[10px] border border-accent/30 bg-accent/5 px-4 py-3 text-[13px] text-text">
          Planned. Every day is now in your week grid — click any of them to adjust it.
        </div>
      )}

      <div className="grid grid-cols-[minmax(0,320px)_minmax(0,1fr)] gap-6">
        {/* ------------------------------------------------ when you can work */}
        <div className="flex flex-col gap-5">
          <section className="rounded-[12px] border border-border bg-bg p-4">
            <div className="mb-1 flex items-center justify-between gap-3">
              <h3 className="text-[14px] font-semibold">Working hours</h3>
              <div className="flex rounded-[8px] border border-border p-0.5">
                {(
                  [
                    ['range', 'These days'],
                    ['pattern', 'Normal week']
                  ] as Array<['range' | 'pattern', string]>
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    onClick={() => setEditing(mode)}
                    className={`rounded-[6px] px-2 py-1 text-[11px] transition-colors ${
                      editing === mode ? 'bg-rail-active text-accent' : 'text-text-dim hover:text-text'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <p className="mb-3 text-[12px] leading-relaxed text-text-dim">
              {editing === 'range'
                ? 'The hours Uurwerk may plan into, day by day. A day switched off is never planned.'
                : 'Your default week. It applies to any day you have not set by hand below.'}
            </p>

            {editing === 'range' ? (
              <ul className="flex max-h-[340px] flex-col gap-2 overflow-y-auto pr-1">
                {days.map((date) => {
                  const day = hoursOn(date)
                  const on = day?.enabled ?? false
                  // A row written for this week specifically, rather than inherited.
                  const own = day?.week !== null && day?.week !== undefined

                  return (
                    <li key={date} className="flex flex-col gap-1.5">
                      <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(event) => void saveDate(date, { enabled: event.target.checked })}
                        className="accent-accent"
                      />
                      <span
                        className={`w-[86px] shrink-0 text-[12px] ${on ? 'text-text' : 'text-text-faint'}`}
                        title={own ? 'Set for this day' : 'From your normal week'}
                      >
                        {shortDate(date)}
                        {own && <span className="ml-1 text-accent">•</span>}
                      </span>

                        {on && day && (
                          <span className="flex items-center gap-1.5">
                            <TimeField
                              value={day.startMin}
                              onChange={(next) => void saveDate(date, { startMin: next })}
                            />
                            <span className="text-text-faint">–</span>
                            <TimeField
                              value={day.endMin}
                              allowEndOfDay
                              onChange={(next) => void saveDate(date, { endMin: next })}
                            />
                          </span>
                        )}
                      </div>

                      {on && day && (
                        <StageHours
                          day={day}
                          weekday={weekdayOf(date)}
                          onSave={(patch) => void saveDate(date, patch)}
                        />
                      )}
                    </li>
                  )
                })}
              </ul>
            ) : (
              <ul className="flex flex-col gap-2">
                {WEEKDAYS.map(({ weekday, label }) => {
                  const day = patternFor(weekday)
                  const on = day?.enabled ?? false

                  return (
                    <li key={weekday} className="flex flex-col gap-1.5">
                      <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(event) =>
                          void savePattern(weekday, { enabled: event.target.checked })
                        }
                        className="accent-accent"
                      />
                      <span
                        className={`w-20 shrink-0 text-[13px] ${on ? 'text-text' : 'text-text-faint'}`}
                      >
                        {label}
                      </span>

                        {on && day && (
                          <span className="flex items-center gap-1.5">
                            <TimeField
                              value={day.startMin}
                              onChange={(next) => void savePattern(weekday, { startMin: next })}
                            />
                            <span className="text-text-faint">–</span>
                            <TimeField
                              value={day.endMin}
                              allowEndOfDay
                              onChange={(next) => void savePattern(weekday, { endMin: next })}
                            />
                          </span>
                        )}
                      </div>

                      {on && day && (
                        <StageHours
                          day={day}
                          weekday={weekday}
                          onSave={(patch) => void savePattern(weekday, patch)}
                        />
                      )}
                    </li>
                  )
                })}
              </ul>
            )}

            {editing === 'range' && (
              <p className="mt-3 border-t border-border pt-2 text-[11px] leading-relaxed text-text-faint">
                A <span className="text-accent">•</span> marks a day you set yourself. The rest
                follow your normal week. Internship work is planned only inside the Stage hours;
                school and personal work only outside them.
              </p>
            )}
          </section>

          <section className="rounded-[12px] border border-border bg-bg p-4">
            <h3 className="mb-1 text-[14px] font-semibold">Already spoken for</h3>
            <p className="mb-3 text-[12px] leading-relaxed text-text-dim">
              Standing commitments like a shift. Uurwerk plans around them every week.
            </p>

            {commitments.length === 0 ? (
              <p className="text-[12px] text-text-faint">
                Nothing yet. Add a shift under Settings → Organizations, or from the day planner.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {commitments.map((commitment) => (
                  <li key={commitment.id} className="flex items-center gap-2 text-[12px]">
                    <span className="w-16 shrink-0 text-text-dim">
                      {WEEKDAYS.find((day) => day.weekday === commitment.weekday)?.label.slice(0, 3)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-text">{commitment.title}</span>
                    <span className="shrink-0 font-mono text-text-dim">
                      {formatDuration(commitment.endMin - commitment.startMin)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* ------------------------------------------------------ the proposal */}
        <div className="min-w-0">
          {!proposal ? (
            <div className="flex h-full items-center justify-center rounded-[12px] border border-dashed border-border p-8 text-center">
              <p className="max-w-sm text-[13px] leading-relaxed text-text-dim">
                Uurwerk fills your working hours deadline first: whatever is due soonest gets the
                time before its due date, and nothing is ever placed after its own deadline.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              {/* The warning you asked for, with both ways out. */}
              {proposal.shortfalls.length > 0 && (
                <section className="rounded-[12px] border border-prio-med/40 bg-prio-med/10 p-4">
                  <h3 className="mb-1 text-[14px] font-semibold text-prio-med">
                    This does not fit before the deadline
                  </h3>
                  <p className="mb-3 text-[12px] leading-relaxed text-text-dim">
                    There are not enough hours between now and the due date. Free up time, or move
                    the date — Uurwerk will not quietly plan past it.
                  </p>

                  <ul className="flex flex-col gap-3">
                    {proposal.shortfalls.map((shortfall) => (
                      <li key={shortfall.taskId} className="rounded-[10px] border border-border bg-bg p-3">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="min-w-0 flex-1 truncate text-[13px] text-text">
                            {shortfall.taskTitle}
                          </span>
                          <span className="shrink-0 font-mono text-[12px] text-prio-med">
                            {formatDuration(shortfall.shortfallMin)} short
                          </span>
                        </div>

                        <div className="mt-1 text-[12px] text-text-dim">
                          Due {shortfall.dueDate} · needs {formatDuration(shortfall.requiredMin)}, room
                          for {formatDuration(shortfall.availableMin)}
                        </div>

                        <div className="mt-2.5 flex flex-wrap items-center gap-2">
                          {shortfall.daysBeforeDue > 0 && (
                            <span className="rounded-[8px] border border-border px-2.5 py-1 text-[12px] text-text-dim">
                              Or add {formatDuration(shortfall.extraMinPerDay)} to each of the{' '}
                              {shortfall.daysBeforeDue} remaining days
                            </span>
                          )}
                          {shortfall.earliestFinishDate ? (
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={busy}
                              onClick={() => void moveDeadline(shortfall)}
                            >
                              Move deadline to {shortfall.earliestFinishDate}
                            </Button>
                          ) : (
                            <span className="text-[12px] text-text-faint">
                              It does not fit in this period at all.
                            </span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <section>
                <h3 className="mb-3 text-[14px] font-semibold">What it wants to do</h3>

                {proposal.blocks.length === 0 ? (
                  <p className="text-[13px] text-text-faint">
                    Nothing could be planned. Check that at least one day has working hours.
                  </p>
                ) : (
                  <ul className="flex max-h-[320px] flex-col gap-1 overflow-y-auto pr-1">
                    {proposal.blocks.map((block, index) => (
                      <li
                        key={`${block.date}-${block.startMin}-${index}`}
                        className="flex items-center gap-3 rounded-[8px] px-2.5 py-2 text-[13px] hover:bg-card-hover"
                        title={block.explanation}
                      >
                        <span className="w-24 shrink-0 text-text-dim">{block.date}</span>
                        <span className="w-24 shrink-0 font-mono text-text-dim tabular-nums">
                          {clock(block.startMin)}–{clock(block.endMin)}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-text">
                          {block.title ?? taskTitle(proposal, block.taskId ?? null)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {proposal.unplaced.length > 0 && (
                <section>
                  <h3 className="mb-2 text-[14px] font-semibold">Did not fit, and has no deadline</h3>
                  <ul className="flex flex-col gap-1 text-[12px] text-text-dim">
                    {proposal.unplaced.map((entry) => (
                      <li key={entry.taskId}>
                        {entry.taskTitle} — {formatDuration(entry.minutes)} ({entry.reason})
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

const clock = (minute: number): string =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`

/** Availability rows are 1=Monday..7=Sunday; Date.getDay() is 0=Sunday. */
const weekdayOf = (date: string): number => ((fromIsoDate(date).getDay() + 6) % 7) + 1

/** 'Fri 21 Aug' — short enough for a narrow column, unambiguous about which day it is. */
const shortDate = (date: string): string =>
  new Date(`${date}T12:00:00`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  })

/** 'Friday 21 August – Sunday 6 September', for the one line that states the horizon. */
const longRange = (from: string, to: string): string => {
  const format = (date: string): string =>
    new Date(`${date}T12:00:00`).toLocaleDateString('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long'
    })
  return `${format(from)} – ${format(to)}`
}

/** The proposal carries ids; the unplaced list is where the titles happen to live. */
function taskTitle(proposal: RangeProposalDto, taskId: string | null): string {
  if (!taskId) return 'Planned block'
  const known = proposal.shortfalls.find((entry) => entry.taskId === taskId)?.taskTitle
  return known ?? proposal.unplaced.find((entry) => entry.taskId === taskId)?.taskTitle ?? 'Task'
}
// `currentWeekKey` lived here: a second, hand-rolled ISO week calculation that disagreed
// with `toIsoWeek` in core around the turn of a year, which is exactly the week you would
// least want a planner to read the wrong availability for. Everything uses the shared one.
