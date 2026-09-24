import { useState } from 'react'
import type { Artifact } from '@core/contract/types.js'
import { Button } from '../../ui/Button.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { CameraIcon, CheckIcon, CloseIcon, FilmIcon } from '../../ui/icons.js'
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
    <div className="flex flex-col gap-5">
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
              <div className="mb-2 flex items-baseline justify-between">
                <h3 className="text-[14px] text-text">{formatLongDate(new Date(`${day}T12:00:00`))}</h3>
                <span className="font-mono text-[12px] text-text-faint">
                  {approved} / {shots.length} approved
                </span>
              </div>

              <div className="flex gap-2 overflow-x-auto pb-2">
                {shots.map((shot) => (
                  <div key={shot.id} className="relative shrink-0">
                    <button
                      onClick={() => toggle(shot)}
                      onDoubleClick={() => setZoomed(shot)}
                      title={`${shot.taskTitle ?? 'No task'} · ${formatClock(shot.capturedAt)}\nClick to include or exclude, double-click to enlarge`}
                      className={`block overflow-hidden rounded-[8px] border transition-colors
                        ${isIncluded(shot) ? 'border-accent/60' : 'border-border opacity-45 hover:opacity-80'}`}
                    >
                      <img
                        src={`file://${shot.path}`}
                        alt=""
                        loading="lazy"
                        className="h-[86px] w-[152px] bg-bg object-cover"
                      />
                    </button>
                    <span
                      className={`pointer-events-none absolute top-1.5 right-1.5 flex h-5 w-5 items-center justify-center rounded-full
                        ${isIncluded(shot) ? 'bg-accent text-[#06210F]' : 'bg-card text-text-dim'}`}
                    >
                      {isIncluded(shot) ? <CheckIcon size={11} /> : <CloseIcon size={11} />}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )
        })
      )}

      <div className="flex items-center justify-between rounded-[12px] border border-border bg-bg px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="text-text-dim">
            <FilmIcon size={16} />
          </span>
          <div className="min-w-0">
            <div className="text-[14px] text-text">Timelapse</div>
            <div className="truncate text-[13px] text-text-dim">
              {timelapse
                ? (timelapse.path.split(/[\\/]/).pop() ?? '')
                : 'None this week — build one from a day in the end-of-day wizard.'}
            </div>
          </div>
        </div>
        {timelapse && (
          <Button variant="ghost" size="sm" onClick={() => onOpen(timelapse.path)}>
            Play
          </Button>
        )}
      </div>

      {zoomed && (
        <button
          onClick={() => setZoomed(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-8"
        >
          <img src={`file://${zoomed.path}`} alt="" className="max-h-full max-w-full rounded-[10px]" />
        </button>
      )}
    </div>
  )
}
