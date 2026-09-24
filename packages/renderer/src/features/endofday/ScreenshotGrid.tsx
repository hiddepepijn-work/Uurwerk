import { useState } from 'react'
import type { Artifact } from '@core/contract/types.js'
import { Button } from '../../ui/Button.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { CameraIcon, CheckIcon, CloseIcon, TrashIcon } from '../../ui/icons.js'
import { formatClock } from '../../lib/format.js'

interface Props {
  screenshots: Artifact[]
  onToggle: (id: string, included: boolean) => void
  onApproveAll: (included: boolean) => void
  onDelete: (id: string) => void
}

/**
 * The approval gate, one frame at a time.
 *
 * Nothing here is included by default. A frame has to be ticked to travel anywhere, which
 * is what makes it safe to capture the screen automatically in the first place: the capture
 * is automatic, the sharing never is.
 *
 * Approve-all exists because a day produces around ninety frames, and a gate that takes
 * ninety clicks is a gate people stop using. It is a shortcut through the *approving*, never
 * through the *seeing* — the frames are all on screen when you press it, and every one can
 * still be untucked afterwards. Deleting is offered next to it for the frames you would
 * rather not merely exclude.
 */
export function ScreenshotGrid({ screenshots, onToggle, onApproveAll, onDelete }: Props) {
  const [zoomed, setZoomed] = useState<Artifact | null>(null)

  if (screenshots.length === 0) {
    return (
      <EmptyState
        icon={<CameraIcon size={26} />}
        title="No screenshots today."
        hint="Frames are captured only while the timer runs, and never while you are idle or in a blocked window. Turn capture on under Settings › Screen capture, or press the Screenshot hotkey to grab one yourself."
      />
    )
  }

  const included = screenshots.filter((s) => s.included).length

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-[13px] text-text-dim">
          <span className="font-mono text-text">{included}</span> of{' '}
          <span className="font-mono text-text">{screenshots.length}</span> approved. Click a tile
          to include or exclude it; click the time to see it full size.
        </p>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => onApproveAll(true)}>
            Approve all
          </Button>
          <Button variant="secondary" size="sm" onClick={() => onApproveAll(false)}>
            Exclude all
          </Button>
        </div>
      </div>

      <div className="grid max-h-[46vh] grid-cols-3 gap-4 overflow-y-auto pr-1">
        {screenshots.map((shot) => (
          <div
            key={shot.id}
            className={`group relative overflow-hidden rounded-[10px] border transition-colors
              ${shot.included ? 'border-accent/50' : 'border-border opacity-55 hover:opacity-90'}`}
          >
            <button onClick={() => onToggle(shot.id, !shot.included)} className="block w-full text-left">
              <img
                src={`file://${shot.path}`}
                alt=""
                loading="lazy"
                className="aspect-video w-full bg-bg object-cover"
              />
              <span
                className={`absolute top-2 right-2 flex h-6 w-6 items-center justify-center rounded-full
                  ${shot.included ? 'bg-accent text-[#06210F]' : 'bg-card text-text-dim'}`}
              >
                {shot.included ? <CheckIcon size={13} /> : <CloseIcon size={13} />}
              </span>
            </button>

            <div className="flex items-center justify-between gap-2 px-3 py-2 text-[12px]">
              <span className="min-w-0 flex-1 truncate text-text-dim" title={shot.taskTitle ?? ''}>
                {shot.taskTitle ?? 'No task'}
              </span>
              <button
                onClick={() => setZoomed(shot)}
                className="shrink-0 font-mono text-text-faint hover:text-text"
              >
                {formatClock(shot.capturedAt)}
              </button>
              <button
                onClick={() => onDelete(shot.id)}
                title="Delete this frame from disk"
                className="shrink-0 text-text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-prio-high"
              >
                <TrashIcon size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>

      <p className="mt-4 text-[13px] text-text-faint">
        Excluded frames are never read, never attached and never uploaded. Approved ones become
        eligible — they still only leave this machine once you tick Screenshots and press Publish.
      </p>

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
