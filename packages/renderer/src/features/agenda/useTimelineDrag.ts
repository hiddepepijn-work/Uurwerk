import { useEffect, useRef, useState, type RefObject } from 'react'
import type { IsoDate } from '@core/contract/types.js'

import { moveBlock, moveBlockToDay } from './actions.js'
import type { AgendaItem } from './agenda-model.js'
import { columnAt, draggedSpan, slotAt, type DragMode } from './drag.js'
import { HOLD_MS, PressTracker, type PointerKind, type PressEvent } from './press.js'

/**
 * Pressing on a timeline, for the day view and the week view alike.
 *
 * A click on an item opens it and a click on an empty moment asks what goes there; a
 * task's block is moved by dragging it (press.ts tells the two apart, per pointer). With a
 * mouse, the top or bottom edge of a block (marked `data-edge`) stretches it instead, and
 * Esc puts back whatever is being dragged. Several `dates` make the timeline a week: a
 * block then moves to the day under the pointer as well.
 */

export interface DragPreview {
  item: AgendaItem
  date: IsoDate
  startMin: number
  endMin: number
}

interface Gesture {
  item: AgendaItem | null
  date: IsoDate
  mode: DragMode
  /** Minutes between the pointer and the part of the block it holds. */
  grab: number
  draggable: boolean
  timer: number | null
  release: () => void
}

export function useTimelineDrag({
  area,
  scroller,
  hourPx,
  dates,
  enabled,
  onOpen,
  onEmpty
}: {
  /** The element the columns fill; minute 0 is its top edge. */
  area: RefObject<HTMLDivElement | null>
  scroller: RefObject<HTMLDivElement | null>
  hourPx: number
  /** One date per column, left to right. */
  dates: IsoDate[]
  enabled: boolean
  onOpen: (item: AgendaItem) => void
  onEmpty: (date: IsoDate, minute: number) => void
}) {
  const press = useRef(new PressTracker())
  const gesture = useRef<Gesture | null>(null)
  const dragging = useRef(false)
  const [drag, setDrag] = useState<DragPreview | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  // A finger dragging a block must not scroll the timeline underneath it.
  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const hold = (event: TouchEvent): void => {
      if (dragging.current) event.preventDefault()
    }
    element.addEventListener('touchmove', hold, { passive: false })
    return () => element.removeEventListener('touchmove', hold)
  }, [scroller])

  // Unmounted mid-drag: no listeners left behind.
  useEffect(() => () => gesture.current?.release(), [])

  const minuteAt = (clientY: number): number => {
    const rect = area.current?.getBoundingClientRect()
    return rect ? ((clientY - rect.top) / hourPx) * 60 : 0
  }

  const dateAt = (clientX: number): IsoDate => {
    const rect = area.current?.getBoundingClientRect()
    return (rect ? dates[columnAt(clientX, rect.left, rect.width, dates.length)] : undefined) ?? dates[0]!
  }

  const previewAt = (current: Gesture & { item: AgendaItem }, clientX: number, clientY: number): DragPreview => ({
    item: current.item,
    // Only a move changes day; stretching keeps the block where it is.
    date: current.mode === 'move' ? dateAt(clientX) : current.item.date,
    ...draggedSpan(current.mode, current.item, minuteAt(clientY) - current.grab)
  })

  const finish = (): void => {
    const current = gesture.current
    if (!current) return
    if (current.timer) window.clearTimeout(current.timer)
    current.release()
    gesture.current = null
    dragging.current = false
  }

  const persist = (next: DragPreview): void => {
    const { item } = next
    if (item.source.type !== 'block') return setDrag(null)
    const unchanged = next.date === item.date && next.startMin === item.startMin && next.endMin === item.endMin
    if (unchanged) return setDrag(null)
    const saving =
      next.date === item.date
        ? moveBlock(item.source.blockId, next.startMin, next.endMin)
        : moveBlockToDay(item.source, next.date, next.startMin, next.endMin)
    // The preview stays until the data behind it has caught up, so the block never jumps back.
    void saving
      .catch((error: unknown) => setProblem(error instanceof Error ? error.message : String(error)))
      .finally(() => setDrag(null))
  }

  const handle = (event: PressEvent, clientX: number, clientY: number): void => {
    const current = gesture.current
    if (!current) return
    if (event.type === 'click') {
      finish()
      if (current.item) onOpen(current.item)
      else onEmpty(current.date, slotAt(minuteAt(clientY)))
      return
    }
    const held = current.draggable && current.item ? { ...current, item: current.item } : null
    if (event.type === 'drag-start') {
      if (!held) return
      dragging.current = true
      navigator.vibrate?.(12)
      setDrag({ item: held.item, date: held.item.date, startMin: held.item.startMin, endMin: held.item.endMin })
      return
    }
    if (event.type === 'drag-move' && held) {
      setDrag(previewAt(held, clientX, clientY))
      return
    }
    if (event.type === 'drag-end' && held) {
      const next = previewAt(held, clientX, clientY)
      finish()
      persist(next)
      return
    }
    if (event.type === 'cancel' || event.type === 'drag-end') {
      finish()
      setDrag(null)
    }
  }

  /** Starts a press on an item, or on an empty moment of `date` when `item` is null. */
  const pointerDown = (event: React.PointerEvent, item: AgendaItem | null, date: IsoDate): void => {
    if (!enabled || event.button !== 0 || gesture.current) return
    event.stopPropagation()
    const pointer = (event.pointerType === 'touch' || event.pointerType === 'pen' ? event.pointerType : 'mouse') as PointerKind
    const draggable = !!item && item.kind === 'task' && item.source.type === 'block'
    // Edges only for a mouse: a finger is too coarse for a six-pixel strip, and the phone
    // keeps moving blocks as it always has.
    const edge = pointer === 'mouse' && draggable ? (event.target as HTMLElement).dataset.edge : undefined
    const mode: DragMode = edge === 'start' || edge === 'end' ? edge : 'move'
    const x = event.clientX
    const y = event.clientY
    press.current.down(pointer, x, y, performance.now())

    const onMove = (move: PointerEvent): void =>
      handle(press.current.move(move.clientX, move.clientY, performance.now()), move.clientX, move.clientY)
    const onUp = (up: PointerEvent): void => {
      handle(press.current.up(up.clientX, up.clientY, performance.now()), up.clientX, up.clientY)
      finish()
    }
    const onCancel = (): void => {
      press.current.cancel()
      finish()
      setDrag(null)
    }
    const onKey = (key: KeyboardEvent): void => {
      if (key.key === 'Escape') onCancel()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey)

    gesture.current = {
      item,
      date,
      mode,
      grab: item ? minuteAt(y) - (mode === 'end' ? item.endMin : item.startMin) : 0,
      draggable,
      timer:
        draggable && pointer !== 'mouse'
          ? window.setTimeout(() => handle(press.current.hold(performance.now()), x, y), HOLD_MS)
          : null,
      release: () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onCancel)
        window.removeEventListener('keydown', onKey)
      }
    }
  }

  return { drag, problem, dismissProblem: () => setProblem(null), pointerDown }
}
