import { useEffect, useState } from 'react'
import type { Task, TimeSegment } from '@core/contract/types.js'
import { api } from '../../api/client.js'
import { Button } from '../../ui/Button.js'
import { Modal } from '../../ui/Modal.js'
import { DateField } from '../../ui/DateField.js'
import { TimeField } from '../../ui/TimeField.js'
import { formatDuration } from '../../lib/format.js'

const MINUTE = 60_000

const pad = (n: number): string => String(n).padStart(2, '0')
const isoDateOf = (ms: number): string => {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
const minuteOf = (ms: number): number => {
  const date = new Date(ms)
  return date.getHours() * 60 + date.getMinutes()
}
const at = (date: string, minute: number): number => {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year!, (month ?? 1) - 1, day ?? 1, 0, 0, 0, 0).getTime() + minute * MINUTE
}

/**
 * Correcting an hour that was already tracked.
 *
 * `tracking.updateSegment` and `removeSegment` have existed on the seam since the tracking
 * model landed and nothing ever called them, which meant a timer you forgot to stop, or
 * started against the wrong task, was uncorrectable from inside the app. Hours you cannot
 * fix are hours you stop trusting, and a report is only worth sending if you trust it.
 *
 * The end is edited as a time on the same day rather than as a second date. A segment that
 * runs past midnight is real — the tracking service allows it — so an end earlier than the
 * start is read as "the next morning" instead of being rejected, which is the only reading
 * that makes 23:30–00:30 expressible.
 *
 * A segment still running has no end yet, and inventing one here would stop the timer
 * behind the user's back. So the end is left alone until it has one.
 */
export function SegmentEditor({
  segment,
  tasks,
  onDone,
  onClose
}: {
  segment: TimeSegment
  tasks: Task[]
  onDone: () => void
  onClose: () => void
}) {
  const running = segment.endedAt === null

  const [date, setDate] = useState(() => isoDateOf(segment.startedAt))
  const [startMin, setStartMin] = useState(() => minuteOf(segment.startedAt))
  const [endMin, setEndMin] = useState(() =>
    segment.endedAt === null ? minuteOf(segment.startedAt) + 30 : minuteOf(segment.endedAt)
  )
  const [taskId, setTaskId] = useState<string | null>(segment.taskId)
  const [note, setNote] = useState(segment.note ?? '')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  useEffect(() => {
    setDate(isoDateOf(segment.startedAt))
    setStartMin(minuteOf(segment.startedAt))
    setEndMin(
      segment.endedAt === null ? minuteOf(segment.startedAt) + 30 : minuteOf(segment.endedAt)
    )
    setTaskId(segment.taskId)
    setNote(segment.note ?? '')
    setConfirmingDelete(false)
  }, [segment])

  const startedAt = at(date, startMin)
  // Wrapping past midnight rather than refusing: an evening that runs into the next day is
  // a real shape, and the alternative is a validation error the user cannot act on.
  // Strictly earlier, not "at or earlier": an end equal to the start is an empty span, and
  // wrapping it would read 09:00-09:00 as a full twenty-four hours of work.
  const endedAt = endMin < startMin ? at(date, endMin) + 24 * 60 * MINUTE : at(date, endMin)
  const durationMin = Math.round((endedAt - startedAt) / MINUTE)
  const spansMidnight = endMin < startMin

  const save = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      await api.tracking.updateSegment(segment.id, {
        taskId,
        startedAt,
        // A running segment keeps running: it is closed by stopping the timer, not here.
        ...(running ? {} : { endedAt }),
        note: note.trim() || null
      })
      onDone()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      await api.tracking.removeSegment(segment.id)
      onDone()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const field =
    'w-full rounded-[10px] border border-border bg-bg px-3.5 py-2.5 text-[14px] text-text outline-none focus:border-accent'

  return (
    <Modal
      open
      onClose={onClose}
      width={560}
      title="Edit tracked time"
      subtitle={
        running
          ? 'This one is still running. Its end is set by stopping the timer.'
          : 'Correcting what was recorded — the hours the report will use.'
      }
      footer={
        <>
          {confirmingDelete ? (
            <span className="text-[13px] text-prio-high">Delete these minutes for good?</span>
          ) : (
            <Button
              variant="danger"
              onClick={() => setConfirmingDelete(true)}
              disabled={busy}
            >
              Delete
            </Button>
          )}

          <div className="flex gap-3">
            {confirmingDelete ? (
              <>
                <Button variant="ghost" onClick={() => setConfirmingDelete(false)} disabled={busy}>
                  Keep it
                </Button>
                <Button variant="danger" onClick={() => void remove()} disabled={busy}>
                  Delete {formatDuration(segment.durationMin)}
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" onClick={onClose} disabled={busy}>
                  Cancel
                </Button>
                <Button variant="primary" onClick={() => void save()} disabled={busy}>
                  Save
                </Button>
              </>
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

      <div className="flex flex-col gap-5">
        <label className="flex flex-col gap-2">
          <span className="text-[13px] text-text-dim">Task</span>
          <select
            value={taskId ?? ''}
            onChange={(event) => setTaskId(event.target.value || null)}
            className={field}
          >
            <option value="">No task — untracked work</option>
            {tasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.title}
              </option>
            ))}
          </select>
          <span className="text-[12px] text-text-faint">
            Time with no task counts toward your totals but appears against nothing in the
            per-task tables or the report.
          </span>
        </label>

        <div className="flex flex-col gap-2">
          <span className="text-[13px] text-text-dim">Day</span>
          <DateField value={date} onChange={setDate} />
        </div>

        <div className="flex items-end gap-4">
          <div className="flex flex-col gap-2">
            <span className="text-[13px] text-text-dim">From</span>
            <TimeField value={startMin} onChange={setStartMin} />
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-[13px] text-text-dim">To</span>
            {running ? (
              <div className="rounded-[8px] border border-border bg-card px-2.5 py-1.5 font-mono text-[13px] text-text-dim">
                running
              </div>
            ) : (
              <TimeField value={endMin} onChange={setEndMin} />
            )}
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-[13px] text-text-dim">Length</span>
            <div className="rounded-[8px] border border-border bg-card px-2.5 py-1.5 font-mono text-[13px] text-text">
              {running ? formatDuration(segment.durationMin) : formatDuration(durationMin)}
            </div>
          </div>
        </div>

        {!running && spansMidnight && (
          <p className="text-[12px] text-text-dim">
            This ends the following morning. That is allowed — it is counted against both days
            where the totals need it.
          </p>
        )}

        <label className="flex flex-col gap-2">
          <span className="text-[13px] text-text-dim">Note</span>
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Optional"
            className={field}
          />
        </label>

        {segment.countsAsStageHours && (
          <p className="text-[12px] leading-relaxed text-text-faint">
            These minutes count toward your internship hours. That was decided when the segment
            started and does not change when you edit it here — reclassifying an area must never
            rewrite hours that have already been reported.
          </p>
        )}
      </div>
    </Modal>
  )
}
