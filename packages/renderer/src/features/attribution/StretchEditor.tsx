import { useEffect, useMemo, useState } from 'react'
import type { Area, Stretch, TaskShare } from '@core/contract/types.js'
import { api } from '../../api/client.js'
import { useLiveQuery } from '../../hooks/useLiveQuery.js'
import { Button } from '../../ui/Button.js'
import { DateField } from '../../ui/DateField.js'
import { Modal } from '../../ui/Modal.js'
import { TimeField } from '../../ui/TimeField.js'
import { formatDuration } from '../../lib/format.js'
import { TaskShareList, minutesFor } from './TaskShareList.js'

/**
 * What the editor was opened on.
 *
 * `add` is hours that were never tracked — the morning you forgot to press START. `edit` is
 * a stretch that exists, whether it was tracked, divided at end of day, or typed in here
 * before. The two share every control, because the question is identical once you have the
 * span: what did that time go to, and in what proportion.
 */
export type StretchTarget =
  | { mode: 'add'; date: string; startMin: number }
  | { mode: 'edit'; id: string }

interface Props {
  target: StretchTarget
  onClose: () => void
  onDone?: () => void
}

/** Two hours is the shape of a forgotten block, and easier to shorten than to invent. */
const DEFAULT_LENGTH_MIN = 120

/**
 * Adding or correcting one stretch of hours.
 *
 * Hours you cannot fix are hours you stop trusting, and a report is only worth sending if you
 * trust it. Tracking covers the days you remember; this covers the mornings you did not, and
 * it asks for them the same way the end-of-day step does — a span and a set of shares —
 * because "I worked 9 to 12, mostly on the survey" is how anyone actually remembers a
 * morning.
 *
 * Hand-entered hours are marked 'manual' by the service and are then out of the end-of-day
 * division's reach. That matters: you have already answered what those hours were, and
 * having tonight's percentages silently re-divide them would throw the answer away.
 */
export function StretchEditor({ target, onClose, onDone }: Props) {
  const adding = target.mode === 'add'

  const [loaded, setLoaded] = useState<Stretch | null>(null)
  const [date, setDate] = useState(adding ? target.date : '')
  const [startMin, setStartMin] = useState(adding ? target.startMin : 9 * 60)
  const [endMin, setEndMin] = useState(
    adding ? target.startMin + DEFAULT_LENGTH_MIN : 11 * 60
  )
  const [shares, setShares] = useState<TaskShare[]>([])
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  useEffect(() => {
    if (adding) return
    void (async () => {
      const stretch = await api.attribution.stretch(target.mode === 'edit' ? target.id : '')
      if (!stretch) {
        setProblem('That stretch no longer exists.')
        return
      }
      setLoaded(stretch)
      setDate(stretch.date)
      setStartMin(stretch.startMin)
      setEndMin(stretch.endMin)
      setShares(stretch.shares)
      setNote(stretch.note ?? '')
    })().catch((error: unknown) => setProblem(errorText(error)))
  }, [adding, target])

  const { data: tasks } = useLiveQuery((client) => client.tasks.list(), ['tasks'], [])
  const { data: areas } = useLiveQuery((client) => client.areas.list(), ['settings'], [])

  const areaById = useMemo(() => {
    const map = new Map<string, Area>()
    for (const area of areas ?? []) map.set(area.id, area)
    return map
  }, [areas])

  // Strictly earlier wraps to the following morning; equal is an empty span, which the
  // service refuses rather than reading as a full day around the clock.
  const spansMidnight = endMin < startMin
  const durationMin = spansMidnight ? 24 * 60 - startMin + endMin : endMin - startMin

  const claimedPct = shares.reduce((sum, share) => sum + share.sharePct, 0)
  const assignedMin = shares.reduce(
    (sum, share) => sum + minutesFor(share.sharePct, claimedPct, durationMin),
    0
  )

  const running = loaded?.running ?? false

  const save = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      const input = { date, startMin, endMin, shares, note: note.trim() || null }
      if (adding) await api.attribution.addStretch(input)
      else await api.attribution.updateStretch(target.mode === 'edit' ? target.id : '', input)
      onDone?.()
      onClose()
    } catch (error) {
      setProblem(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      await api.attribution.removeStretch(target.mode === 'edit' ? target.id : '')
      onDone?.()
      onClose()
    } catch (error) {
      setProblem(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={680}
      title={adding ? 'Add hours' : 'Edit these hours'}
      subtitle={
        adding
          ? 'For time you worked but never tracked. Say when, then roughly what it went to.'
          : running
            ? 'This one is still running. Stop the timer before changing its hours.'
            : 'Correcting one stretch. The rest of the day is left exactly as it is.'
      }
      footer={
        <>
          {!adding && !running ? (
            confirmingDelete ? (
              <span className="text-[13px] text-prio-high">Delete these hours for good?</span>
            ) : (
              <Button variant="danger" onClick={() => setConfirmingDelete(true)} disabled={busy}>
                Delete
              </Button>
            )
          ) : (
            <span />
          )}

          <div className="flex items-center gap-3">
            {confirmingDelete ? (
              <>
                <Button variant="ghost" onClick={() => setConfirmingDelete(false)} disabled={busy}>
                  Keep them
                </Button>
                <Button variant="danger" onClick={() => void remove()} disabled={busy}>
                  Delete {formatDuration(loaded?.durationMin ?? durationMin)}
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" onClick={onClose} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={() => void save()}
                  disabled={busy || running || durationMin <= 0}
                >
                  {adding ? `Add ${formatDuration(durationMin)}` : 'Save'}
                </Button>
              </>
            )}
          </div>
        </>
      }
    >
      {problem && (
        <div className="mb-5 rounded-[10px] border border-prio-high/40 bg-prio-high/10 px-4 py-3 text-[13px] leading-relaxed text-prio-high">
          {problem}
        </div>
      )}

      <div className="flex flex-col gap-6">
        <div className="flex items-end gap-4">
          <div className="flex min-w-0 flex-col gap-2">
            <span className="text-[13px] text-text-dim">Day</span>
            <DateField value={date} onChange={setDate} />
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-[13px] text-text-dim">From</span>
            <TimeField value={startMin} onChange={setStartMin} />
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-[13px] text-text-dim">To</span>
            <TimeField value={endMin} onChange={setEndMin} />
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-[13px] text-text-dim">Length</span>
            <div className="rounded-[8px] border border-border bg-card px-2.5 py-1.5 font-mono text-[13px] text-text">
              {durationMin <= 0 ? '—' : formatDuration(durationMin)}
            </div>
          </div>
        </div>

        {durationMin <= 0 && (
          <p className="text-[12px] text-prio-med">
            The end has to be later than the start. Equal times are no time at all.
          </p>
        )}

        {spansMidnight && (
          <p className="text-[12px] text-text-dim">
            This ends the following morning. That is allowed — it is counted against both days
            where the totals need it.
          </p>
        )}

        <div>
          <div className="mb-2 flex items-baseline justify-between">
            <h3 className="text-[15px] font-semibold">What did that time go to?</h3>
            <span className="text-[13px] text-text-dim">
              {shares.length === 0
                ? 'optional'
                : `${formatDuration(assignedMin)} of ${formatDuration(durationMin)} assigned`}
            </span>
          </div>
          <div className="rounded-[12px] border border-border bg-card p-4">
            <TaskShareList
              shares={shares}
              onChange={setShares}
              poolMin={durationMin}
              tasks={tasks ?? []}
              areaById={areaById}
              compact
              emptyHint="Add the tasks this time went to. You can leave it empty — the hours still count as worked, they just count toward no task."
            />
          </div>
        </div>

        <label className="flex flex-col gap-2">
          <span className="text-[13px] text-text-dim">Note</span>
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Optional — e.g. forgot to start the timer"
            className="w-full rounded-[10px] border border-border bg-bg px-3.5 py-2.5 text-[14px] text-text outline-none placeholder:text-text-faint focus:border-accent"
          />
        </label>

        {!adding && loaded?.attribution === 'estimated' && (
          <p className="text-[12px] leading-relaxed text-text-faint">
            These minutes were measured but divided afterwards. Changing the shares leaves that
            as it is; changing the times makes the whole stretch hand-entered, because from
            then on the span is yours rather than the clock&apos;s.
          </p>
        )}
      </div>
    </Modal>
  )
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
