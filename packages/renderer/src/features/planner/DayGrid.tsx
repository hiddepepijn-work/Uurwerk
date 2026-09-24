import { useCallback, useEffect, useRef, useState } from 'react'
import type { FixedEvent, PlanBlock } from '@core/contract/types.js'
import { formatMinuteOfDay } from '../../lib/format.js'

const SNAP_MIN = 15
const MIN_BLOCK_MIN = 15
const PX_PER_MIN = 1.15

interface Props {
  startMin: number
  endMin: number
  blocks: PlanBlock[]
  /**
   * Meetings and other immovable commitments.
   *
   * They are not plan blocks and never become them: the planner treats them as walls it
   * schedules around. Drawing them here is what makes a half-empty afternoon legible as
   * "there is a meeting in it" rather than as unexplained missing time.
   */
  events: FixedEvent[]
  /** Called once, when a drag or resize finishes — not on every pixel of movement. */
  onChange: (id: string, startMin: number, endMin: number) => void
  onRemove: (id: string) => void
  onToggleLock: (block: PlanBlock) => void
  onRemoveEvent: (id: string) => void
}

type DragState =
  | { kind: 'move'; id: string; grabOffsetMin: number; startMin: number; endMin: number }
  | { kind: 'resize'; id: string; startMin: number; endMin: number }
  | null

const snap = (minute: number): number => Math.round(minute / SNAP_MIN) * SNAP_MIN

const KIND_STYLES: Record<string, string> = {
  task: 'bg-block-blue/70 border-block-blue',
  meeting: 'bg-block-amber/60 border-block-amber',
  break: 'bg-card border-border',
  buffer: 'bg-transparent border-dashed border-border'
}

/**
 * The day, drawn to scale, with blocks you can drag and stretch.
 *
 * Changes are held locally while the pointer is down and written once on release: saving
 * on every mouse move would mean hundreds of database writes for one drag, and a plan
 * that flickers as it re-reads itself mid-gesture.
 *
 * Locked blocks and fixed events do not move. That is the whole point of locking them —
 * a planner that can quietly shift your 10:00 meeting is worse than no planner.
 */
export function DayGrid({
  startMin,
  endMin,
  blocks,
  events,
  onChange,
  onRemove,
  onToggleLock,
  onRemoveEvent
}: Props) {
  const [drag, setDrag] = useState<DragState>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)

  const span = Math.max(60, endMin - startMin)
  const height = span * PX_PER_MIN
  const toY = (minute: number): number => (minute - startMin) * PX_PER_MIN
  const toMinute = useCallback(
    (clientY: number): number => {
      const rect = surfaceRef.current?.getBoundingClientRect()
      if (!rect) return startMin
      return startMin + (clientY - rect.top) / PX_PER_MIN
    },
    [startMin]
  )

  useEffect(() => {
    if (!drag) return

    const onMove = (event: PointerEvent): void => {
      const minute = toMinute(event.clientY)

      setDrag((current) => {
        if (!current) return current
        if (current.kind === 'move') {
          const duration = current.endMin - current.startMin
          let next = snap(minute - current.grabOffsetMin)
          next = Math.max(startMin, Math.min(next, endMin - duration))
          return { ...current, startMin: next, endMin: next + duration }
        }
        const next = Math.max(
          current.startMin + MIN_BLOCK_MIN,
          Math.min(snap(minute), endMin)
        )
        return { ...current, endMin: next }
      })
    }

    const onUp = (): void => {
      setDrag((current) => {
        if (current) onChange(current.id, current.startMin, current.endMin)
        return null
      })
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [drag, toMinute, startMin, endMin, onChange])

  const hours: number[] = []
  for (let hour = Math.ceil(startMin / 60); hour * 60 <= endMin; hour++) hours.push(hour)

  return (
    <div className="flex gap-3">
      {/* hour gutter */}
      <div className="relative w-12 shrink-0" style={{ height }}>
        {hours.map((hour) => (
          <span
            key={hour}
            className="absolute right-0 -translate-y-1/2 font-mono text-[11px] text-text-dim tabular-nums"
            style={{ top: toY(hour * 60) }}
          >
            {String(hour).padStart(2, '0')}:00
          </span>
        ))}
      </div>

      <div
        ref={surfaceRef}
        className="relative flex-1 rounded-[10px] border border-border bg-bg"
        style={{ height }}
      >
        {hours.map((hour) => (
          <div
            key={hour}
            className="absolute right-0 left-0 border-t border-border/60"
            style={{ top: toY(hour * 60) }}
          />
        ))}

        {/* Drawn under the blocks: a meeting is the shape of the day, not an item in it. */}
        {events.map((event) => (
          <div
            key={event.id}
            title={`${event.title} · ${formatMinuteOfDay(event.startMin)}–${formatMinuteOfDay(event.endMin)}`}
            className="group absolute right-2 left-2 overflow-hidden rounded-[8px] border border-dashed border-block-amber bg-block-amber/25 px-3 py-1.5 select-none"
            style={{
              top: toY(event.startMin),
              height: Math.max(22, (event.endMin - event.startMin) * PX_PER_MIN - 2)
            }}
          >
            <div className="flex items-start justify-between gap-2">
              <span className="min-w-0 flex-1 truncate text-[13px] text-text">{event.title}</span>
              <span className="shrink-0 font-mono text-[11px] text-text-dim tabular-nums">
                {formatMinuteOfDay(event.startMin)}–{formatMinuteOfDay(event.endMin)}
              </span>
            </div>

            <button
              onClick={() => onRemoveEvent(event.id)}
              title="Remove this commitment"
              className="absolute top-1 right-1 hidden rounded p-1 text-[10px] text-text-faint group-hover:block hover:text-prio-high"
            >
              ✕
            </button>
          </div>
        ))}

        {blocks.map((block) => {
          const live = drag?.id === block.id ? drag : null
          const from = live?.startMin ?? block.startMin
          const to = live?.endMin ?? block.endMin
          const immovable = block.locked || block.fixed
          const minutes = to - from

          return (
            <div
              key={block.id}
              // The planner's reasoning, one hover away — a block you cannot interrogate
              // is a block you end up deleting instead of understanding.
              title={block.explanation ?? undefined}
              className={`group absolute right-2 left-2 overflow-hidden rounded-[8px] border px-3 py-1.5 select-none
                ${KIND_STYLES[block.kind] ?? KIND_STYLES['task']}
                ${immovable ? 'cursor-not-allowed' : 'cursor-grab active:cursor-grabbing'}
                ${live ? 'z-10 ring-1 ring-accent' : ''}`}
              style={{ top: toY(from), height: Math.max(22, minutes * PX_PER_MIN - 2) }}
              onPointerDown={(event) => {
                if (immovable) return
                if ((event.target as HTMLElement).dataset['handle']) return
                event.preventDefault()
                setDrag({
                  kind: 'move',
                  id: block.id,
                  grabOffsetMin: toMinute(event.clientY) - block.startMin,
                  startMin: block.startMin,
                  endMin: block.endMin
                })
              }}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 flex-1 truncate text-[13px] text-text">
                  {block.taskTitle ?? block.title ?? 'Untitled'}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-text-dim tabular-nums">
                  {formatMinuteOfDay(from)}–{formatMinuteOfDay(to)}
                </span>
              </div>

              {minutes >= 45 && (
                <div className="flex items-center gap-2 truncate text-[11px] text-text-dim">
                  {block.projectName && <span className="truncate">{block.projectName}</span>}
                  {block.score !== null && (
                    <span className="shrink-0 text-accent" title={block.explanation ?? undefined}>
                      score {block.score}
                    </span>
                  )}
                </div>
              )}

              {/* Controls appear on hover so the grid stays quiet at rest. */}
              <div className="absolute top-1 right-1 hidden gap-1 group-hover:flex">
                <button
                  onClick={() => onToggleLock(block)}
                  title={block.locked ? 'Unlock' : 'Lock in place'}
                  className={`rounded p-1 text-[10px] ${block.locked ? 'text-accent' : 'text-text-faint hover:text-text'}`}
                >
                  {block.locked ? '🔒' : '🔓'}
                </button>
                <button
                  onClick={() => onRemove(block.id)}
                  title="Remove from the plan"
                  className="rounded p-1 text-[10px] text-text-faint hover:text-prio-high"
                >
                  ✕
                </button>
              </div>

              {!immovable && (
                <div
                  data-handle="resize"
                  onPointerDown={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    setDrag({
                      kind: 'resize',
                      id: block.id,
                      startMin: block.startMin,
                      endMin: block.endMin
                    })
                  }}
                  className="absolute right-0 bottom-0 left-0 h-2 cursor-ns-resize"
                />
              )}
            </div>
          )
        })}

        {blocks.length === 0 && events.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-[13px] text-text-faint">
            Add a task from the left to start planning
          </div>
        )}
      </div>
    </div>
  )
}
