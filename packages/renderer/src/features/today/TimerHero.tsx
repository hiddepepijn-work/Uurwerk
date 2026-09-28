import type { Area, TimeSegment } from '@core/contract/types.js'
import { Button } from '../../ui/Button.js'
import { PlayIcon, StopIcon } from '../../ui/icons.js'
import { formatClock, formatDuration, formatStopwatch } from '../../lib/format.js'
import { AREA_COLORS } from '../agenda/agenda-model.js'

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

  // The four system areas wear their own tint; an area the user added stays grey.
  const areaColor = area ? AREA_COLORS[area.id] : undefined

  return (
    <section
      className="flex flex-col gap-3.5 rounded-modal bg-card px-[18px] pt-5 pb-[18px]
        wide:justify-between wide:gap-6 wide:px-8 wide:py-[28px]"
    >
      <div className="flex flex-col gap-1 wide:gap-[18px]">
        <div
          className={`font-display text-[58px] leading-none font-bold tracking-[-1.6px] tabular-nums
            wide:text-[76px] wide:leading-[0.95] wide:tracking-[-2px]
            ${running ? 'text-text' : 'text-text-faint'}`}
        >
          {formatStopwatch(elapsedSec)}
        </div>

        {switched && (
          <div className="text-[13px] font-semibold text-text-dim wide:text-[15px] wide:font-normal">
            <span className="font-bold text-accent-soft">on this task</span>
            <span> · </span>
            <span>
              working session {formatDuration(Math.floor(runElapsedSec / 60))}
              {runStartedAt !== null && `, since ${formatClock(runStartedAt)}`}
            </span>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2 border-l-[3px] border-accent py-0.5 pl-3 wide:gap-3 wide:pl-3.5">
        <div className="text-[20px] leading-tight font-bold text-text wide:text-[24px] wide:tracking-[-0.2px]">
          {/* An untasked run is not an unnamed one: the clock is running and the reason it
              has no task is that naming it is deferred, which the line has to say. */}
          {segment?.taskTitle ??
            (untasked ? (
              <span className="text-text">Working &mdash; task not set yet</span>
            ) : (
              <span className="text-text-dim">Not tracking</span>
            ))}
        </div>
        <div className="flex flex-wrap items-center gap-2.5 text-[13px] font-semibold text-text-dim empty:hidden wide:gap-3 wide:text-[14px]">
          {untasked && <span>Divide this stretch over tasks at end of day</span>}
          {segment?.projectName && (
            <span className="flex items-center gap-1.5">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M5 21V4h12l-2.5 4L17 12H5" />
              </svg>
              {segment.projectName}
            </span>
          )}
          {area && (
            <span
              className={`rounded-pill px-[11px] py-[5px] text-[13px] font-bold ${
                areaColor ? '' : 'bg-secondary text-text-dim'
              }`}
              style={areaColor ? { background: areaColor.tint, color: areaColor.soft } : undefined}
            >
              {area.name}
              {!area.countsAsStageHours && ' · not stage hours'}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 wide:gap-2.5">
        {running ? (
          <>
            <Button
              size="lg"
              variant="primary"
              icon={<StopIcon size={16} />}
              onClick={onStop}
              className="w-auto flex-1 basis-0 tracking-[0.6px] wide:w-[260px] wide:flex-none wide:basis-auto"
            >
              STOP
            </Button>
            <Button
              size="lg"
              variant="secondary"
              hint={hotkey}
              onClick={onPick}
              className="flex-1 basis-0 wide:flex-none wide:basis-auto"
            >
              Switch task
            </Button>
          </>
        ) : (
          <>
            <Button
              size="lg"
              variant="primary"
              icon={<PlayIcon size={16} />}
              hint={hotkey}
              onClick={onStart}
              className="w-auto flex-1 basis-0 tracking-[0.6px] wide:w-[260px] wide:flex-none wide:basis-auto"
            >
              START
            </Button>
            <Button
              size="lg"
              variant="secondary"
              onClick={onPick}
              className="flex-1 basis-0 wide:flex-none wide:basis-auto"
            >
              Start on a task
            </Button>
          </>
        )}
      </div>
    </section>
  )
}
