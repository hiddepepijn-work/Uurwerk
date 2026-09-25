import type { Area, TimeSegment } from '@core/contract/types.js'
import { Button } from '../../ui/Button.js'
import { PlayIcon, StopIcon } from '../../ui/icons.js'
import { formatClock, formatDuration, formatStopwatch } from '../../lib/format.js'

interface Props {
  segment: TimeSegment | null
  /** Seconds on the current task. Resets on a switch. */
  elapsedSec: number
  /** Seconds since the working stretch began. Survives switches. */
  runElapsedSec: number
  runStartedAt: number | null
  area: Area | null
  hotkey: string
  /**
   * Begins a run with no task on it.
   *
   * What START does now. Naming the task up front assumed you knew what the next hour
   * held; on a day spent flipping between three things you do not, and guessing wrong is
   * worse than saying nothing — the end-of-day step divides the stretch afterwards.
   */
  onStart: () => void
  /** Opens the task picker, for the times you do know. */
  onPick: () => void
  onStop: () => void
}

/**
 * The one thing this screen exists for: what am I on, and for how long.
 * Everything else on Today is secondary and sits below or beside it.
 */
export function TimerHero({
  segment,
  elapsedSec,
  runElapsedSec,
  runStartedAt,
  area,
  hotkey,
  onStart,
  onPick,
  onStop
}: Props) {
  const running = segment !== null
  const untasked = running && segment!.taskId === null

  /**
   * The big number is time on the current task, so it restarts on a switch.
   *
   * That is the useful figure here: the day total already has its own tile in the stat
   * row, so repeating it would waste the largest element on the screen. The working
   * session is kept underneath, which is what stops the restart from reading as lost time.
   */
  const switched = running && runElapsedSec - elapsedSec > 30

  return (
    <div>
      <div
        className={`font-mono text-[56px] wide:text-[76px] leading-none font-semibold tracking-tight tabular-nums
          ${running ? 'text-text' : 'text-text-faint'}`}
      >
        {formatStopwatch(elapsedSec)}
      </div>

      {switched && (
        <div className="mt-2 flex items-center gap-2 text-[13px] text-text-dim">
          <span className="text-accent">on this task</span>
          <span className="text-text-faint">·</span>
          <span>
            working session {formatDuration(Math.floor(runElapsedSec / 60))}
            {runStartedAt !== null && `, since ${formatClock(runStartedAt)}`}
          </span>
        </div>
      )}

      <div className="mt-6 mb-7 border-l-[3px] border-accent pl-4">
        <div className="text-[19px] font-medium text-text">
          {/* An untasked run is not an unnamed one: the clock is running and the reason it
              has no task is that naming it is deferred, which the line has to say. */}
          {segment?.taskTitle ??
            (untasked ? (
              <span className="text-text">Working &mdash; task not set yet</span>
            ) : (
              <span className="text-text-dim">Not tracking</span>
            ))}
        </div>
        <div className="mt-1 flex items-center gap-2 text-[13px] text-text-dim">
          {untasked && <span>Divide this stretch over tasks at end of day</span>}
          {segment?.projectName && (
            <span className="flex items-center gap-1.5">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 21V4h12l-2 4 2 4H4" />
              </svg>
              {segment.projectName}
            </span>
          )}
          {area && (
            <span
              className={`rounded-full border px-2 py-0.5 text-[11px] ${
                area.countsAsStageHours
                  ? 'border-accent/30 bg-accent/10 text-accent'
                  : 'border-border bg-bg text-text-dim'
              }`}
            >
              {area.name}
              {!area.countsAsStageHours && ' · not stage hours'}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        {running ? (
          <>
            <Button
              size="lg"
              variant="primary"
              icon={<StopIcon size={15} />}
              onClick={onStop}
              className="w-auto flex-1 wide:w-[260px] wide:flex-none"
            >
              STOP
            </Button>
            <Button size="lg" variant="secondary" hint={hotkey} onClick={onPick} className="flex-1">
              Switch task
            </Button>
          </>
        ) : (
          <>
            <Button
              size="lg"
              variant="primary"
              icon={<PlayIcon size={15} />}
              hint={hotkey}
              onClick={onStart}
              className="w-auto flex-1 wide:w-[260px] wide:flex-none"
            >
              START
            </Button>
            <Button size="lg" variant="secondary" onClick={onPick} className="flex-1">
              Start on a task
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
