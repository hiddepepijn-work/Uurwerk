/**
 * Where a dragged block lands. Pure geometry, shared by the day and the week timeline so
 * both move and stretch a block the same way.
 *
 *   move    the whole block follows the pointer, its length kept
 *   start   the top edge follows the pointer, the end stays put
 *   end     the bottom edge follows the pointer, the start stays put
 */

import { snapMinute } from './press.js'

export type DragMode = 'move' | 'start' | 'end'

/** The step a block snaps to while dragged: a quarter of an hour, as everywhere. */
export const SNAP_MIN = 15

const DAY_MIN = 24 * 60

/**
 * The span a block gets when its grabbed part is at minute `at` (not yet snapped): the start
 * for a move or a top edge, the end for a bottom edge. Never outside the day, and a stretched
 * block never gets shorter than one step (or its own length, if it already was).
 */
export function draggedSpan(
  mode: DragMode,
  span: { startMin: number; endMin: number },
  at: number,
  step = SNAP_MIN
): { startMin: number; endMin: number } {
  const length = span.endMin - span.startMin
  const shortest = Math.min(step, length)
  if (mode === 'move') {
    const startMin = Math.max(0, Math.min(snapMinute(at, step), DAY_MIN - length))
    return { startMin, endMin: startMin + length }
  }
  if (mode === 'start') {
    return { startMin: Math.max(0, Math.min(snapMinute(at, step), span.endMin - shortest)), endMin: span.endMin }
  }
  return { startMin: span.startMin, endMin: Math.min(DAY_MIN, Math.max(snapMinute(at, step), span.startMin + shortest)) }
}

/** Which of `count` equal columns, starting at `left` and `width` wide, holds `x`. */
export const columnAt = (x: number, left: number, width: number, count: number): number =>
  count <= 1 || width <= 0 ? 0 : Math.max(0, Math.min(count - 1, Math.floor(((x - left) / width) * count)))

/** Clicked an empty moment: the quarter it falls in, the last one still leaving room. */
export const slotAt = (minute: number): number => Math.max(0, Math.min(DAY_MIN - SNAP_MIN, Math.floor(minute / SNAP_MIN) * SNAP_MIN))

/**
 * How tall the grab strip at a block's top and bottom edge is: six pixels, less on a short
 * block so the middle can still be taken to move it. Zero means too short to stretch here.
 */
export const edgePx = (height: number): number => {
  const px = Math.min(6, Math.floor(height / 4))
  return px >= 3 ? px : 0
}
