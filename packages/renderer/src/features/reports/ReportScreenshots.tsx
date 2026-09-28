import { useState } from 'react'
import type { Artifact } from '@core/contract/types.js'
import { Button } from '../../ui/Button.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { CameraIcon, CheckIcon, CloseIcon, FilmIcon, PlayIcon } from '../../ui/icons.js'
import { formatClock, formatLongDate } from '../../lib/format.js'

interface Props {
  screenshots: Artifact[]
  timelapse: Artifact | null
  onToggle: (id: string, included: boolean) => Promise<void>
  onOpen: (path: string) => void
}

/**
 * The week's frames, grouped by day, with the same approval gate as the end-of-day wizard.
 *
 * It is the same switch, deliberately reachable from two places: you normally approve as
 * you go, but on Sunday you are looking at the whole week and that is exactly when you
 * notice the frame you should not send.
 */
export function ReportScreenshots({ screenshots, timelapse, onToggle, onOpen }: Props) {
  const [local, setLocal] = useState<Record<string, boolean>>({})
  const [zoomed, setZoomed] = useState<Artifact | null>(null)

  const isIncluded = (shot: Artifact): boolean => local[shot.id] ?? shot.included

  const toggle = (shot: Artifact): void => {
    const next = !isIncluded(shot)
    setLocal((current) => ({ ...current, [shot.id]: next }))
    void onToggle(shot.id, next)
  }

  const byDay = new Map<string, Artifact[]>()
  for (const shot of screenshots) {
    byDay.set(shot.day, [...(byDay.get(shot.day) ?? []), shot])
  }

  return (
    <div className="flex flex-col gap-3 wide:gap-4">
      {screenshots.length === 0 ? (
        <EmptyState
          icon={<CameraIcon size={26} />}
          title="No screenshots this week."
          hint="The document will say so in Dutch rather than leaving an empty section."
        />
      ) : (
        [...byDay.entries()].map(([day, shots]) => {
          const approved = shots.filter(isIncluded).length
          return (
            <div key={day}>
              <div className="mb-2.5 flex items-baseline justify-between gap-3">
                <h3 className="text-[15px] font-bold text-text">{formatLongDate(new Date(`${day}T12:00:00`))}</h3>
                <span className="shrink-0 font-mono text-[13px] font-semibold text-text-dim wide:font-bold wide:text-accent-soft">
                  {approved} / {shots.length} approved
                </span>
              </div>

              {/* On the phone the strip runs off the right edge, so it reads as scrollable. */}
              <div className="-mr-4 flex gap-2 overflow-x-auto pb-2 wide:mr-0 wide:gap-2.5">
                {shots.map((shot) => (
                  <div key={shot.id} className="relative shrink-0">
                    <button
                      onClick={() => toggle(shot)}
                      onDoubleClick={() => setZoomed(shot)}
                      title={`${shot.taskTitle ?? 'No task'} · ${formatClock(shot.capturedAt)}\nClick to include or exclude, double-click to enlarge`}
                      className={`block overflow-hidden rounded-input bg-input transition-opacity
                        ${isIncluded(shot) ? '' : 'opacity-40 hover:opacity-80'}`}
                    >
                      <img
                        src={`file://${shot.path}`}
                        alt=""
                        loading="lazy"
                        className="h-[86px] w-[152px] bg-input object-cover"
                      />
                    </button>
                    <span
                      className={`pointer-events-none absolute top-1.5 right-1.5 flex h-[22px] w-[22px] items-center justify-center rounded-full
                        ${isIncluded(shot) ? 'bg-accent text-accent-ink' : 'bg-track text-text-dim'}`}
                    >
                      {isIncluded(shot) ? <CheckIcon size={12} /> : <CloseIcon size={11} />}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )
        })
      )}

      <div className="flex items-center justify-between gap-3 rounded-[18px] bg-card px-3.5 py-3 wide:rounded-[16px] wide:bg-input wide:px-4 wide:py-3.5">
        <div className="flex min-w-0 items-center gap-3 wide:gap-3.5">
          <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-input bg-input text-accent-soft wide:h-10 wide:w-10 wide:bg-rail-active">
            <FilmIcon size={20} />
          </span>
          <div className="min-w-0">
            <div className="text-[15px] font-bold text-text">Timelapse</div>
            <div className="truncate text-[13px] font-medium text-text-dim wide:font-normal">
              {timelapse
                ? (timelapse.path.split(/[\\/]/).pop() ?? '')
                : 'None this week — build one from a day in the end-of-day wizard.'}
            </div>
          </div>
        </div>
        {timelapse && (
          <Button
            variant="ghost"
            size="sm"
            icon={<PlayIcon size={13} />}
            className="text-[14px]"
            onClick={() => onOpen(timelapse.path)}
          >
            Play
          </Button>
        )}
      </div>

      {zoomed && (
        <button
          onClick={() => setZoomed(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-8"
        >
          <img src={`file://${zoomed.path}`} alt="" className="max-h-full max-w-full rounded-input" />
        </button>
      )}
    </div>
  )
}
