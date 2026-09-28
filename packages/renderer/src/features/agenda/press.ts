/**
 * Telling a click from a drag, and a drag from a scroll.
 *
 *   mouse        A click is a press that does not travel. A drag starts only once the
 *                pointer has moved a few pixels with the button down — so a slightly
 *                shaky click is still a click.
 *   touch, pen   A tap opens; a swipe scrolls, as always. A drag needs the finger held
 *                still for a moment first (long press), which is never how you scroll,
 *                so the agenda cannot be dragged by accident while swiping through it.
 */

export type PointerKind = 'mouse' | 'touch' | 'pen'

export type PressEvent =
  | { type: 'click' }
  | { type: 'drag-start'; x: number; y: number }
  | { type: 'drag-move'; x: number; y: number }
  | { type: 'drag-end'; x: number; y: number }
  | { type: 'cancel' }
  | { type: 'none' }

/** Mouse: this far with the button down makes it a drag. */
export const MOUSE_SLOP = 6
/** Touch: moving this far before the hold completes makes it a scroll. */
export const TOUCH_SLOP = 8
/** Touch: held still this long, the finger picks the block up. */
export const HOLD_MS = 380

type State =
  | { kind: 'idle' }
  | { kind: 'pressed'; pointer: PointerKind; x: number; y: number; at: number }
  | { kind: 'dragging' }
  | { kind: 'cancelled' }

export class PressTracker {
  private state: State = { kind: 'idle' }

  down(pointer: PointerKind, x: number, y: number, at: number): PressEvent {
    this.state = { kind: 'pressed', pointer, x, y, at }
    return { type: 'none' }
  }

  move(x: number, y: number, at: number): PressEvent {
    const state = this.state
    if (state.kind === 'dragging') return { type: 'drag-move', x, y }
    if (state.kind !== 'pressed') return { type: 'none' }
    const moved = Math.hypot(x - state.x, y - state.y)
    if (state.pointer === 'mouse') {
      if (moved < MOUSE_SLOP) return { type: 'none' }
      this.state = { kind: 'dragging' }
      return { type: 'drag-start', x, y }
    }
    // Touch: moving before the hold is done is a scroll, and stays one.
    if (at - state.at < HOLD_MS) {
      if (moved < TOUCH_SLOP) return { type: 'none' }
      this.state = { kind: 'cancelled' }
      return { type: 'cancel' }
    }
    this.state = { kind: 'dragging' }
    return { type: 'drag-start', x, y }
  }

  /** The hold timer: a touch held still long enough is picked up, even before it moves. */
  hold(at: number): PressEvent {
    const state = this.state
    if (state.kind !== 'pressed' || state.pointer === 'mouse' || at - state.at < HOLD_MS) return { type: 'none' }
    this.state = { kind: 'dragging' }
    return { type: 'drag-start', x: state.x, y: state.y }
  }

  up(x: number, y: number, at: number): PressEvent {
    const state = this.state
    this.state = { kind: 'idle' }
    if (state.kind === 'dragging') return { type: 'drag-end', x, y }
    if (state.kind !== 'pressed') return { type: 'none' }
    if (Math.hypot(x - state.x, y - state.y) >= (state.pointer === 'mouse' ? MOUSE_SLOP : TOUCH_SLOP)) return { type: 'none' }
    // A touch held long and let go without moving is neither a tap nor a move.
    if (state.pointer !== 'mouse' && at - state.at >= HOLD_MS) return { type: 'none' }
    return { type: 'click' }
  }

  cancel(): PressEvent {
    const wasDragging = this.state.kind === 'dragging'
    this.state = { kind: 'idle' }
    return wasDragging ? { type: 'cancel' } : { type: 'none' }
  }

  get dragging(): boolean {
    return this.state.kind === 'dragging'
  }
}

/** A position on the timeline to a minute of the day, on the quarter hour. */
export const snapMinute = (minute: number, step = 15): number =>
  Math.max(0, Math.min(24 * 60, Math.round(minute / step) * step))
