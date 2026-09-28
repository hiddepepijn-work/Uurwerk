import { describe, expect, it } from 'vitest'

import { columnAt, draggedSpan, edgePx, slotAt } from './drag.js'

const block = { startMin: 9 * 60, endMin: 10 * 60 }

describe('draggedSpan', () => {
  it('move: keeps the length and snaps the start to a quarter', () => {
    expect(draggedSpan('move', block, 11 * 60 + 7)).toEqual({ startMin: 660, endMin: 720 })
    expect(draggedSpan('move', block, 11 * 60 + 8)).toEqual({ startMin: 675, endMin: 735 })
  })

  it('move: stays within the day', () => {
    expect(draggedSpan('move', block, -40)).toEqual({ startMin: 0, endMin: 60 })
    expect(draggedSpan('move', block, 23 * 60 + 30)).toEqual({ startMin: 1380, endMin: 1440 })
  })

  it('start: moves the top edge only, never past the end', () => {
    expect(draggedSpan('start', block, 8 * 60 + 20)).toEqual({ startMin: 495, endMin: 600 })
    expect(draggedSpan('start', block, 11 * 60)).toEqual({ startMin: 585, endMin: 600 })
    expect(draggedSpan('start', block, -30)).toEqual({ startMin: 0, endMin: 600 })
  })

  it('end: moves the bottom edge only, never before the start', () => {
    expect(draggedSpan('end', block, 11 * 60 + 50)).toEqual({ startMin: 540, endMin: 705 })
    expect(draggedSpan('end', block, 8 * 60)).toEqual({ startMin: 540, endMin: 555 })
    expect(draggedSpan('end', block, 25 * 60)).toEqual({ startMin: 540, endMin: 1440 })
  })

  it('a block already shorter than a step can still be stretched', () => {
    const short = { startMin: 600, endMin: 610 }
    expect(draggedSpan('end', short, 590)).toEqual({ startMin: 600, endMin: 610 })
    expect(draggedSpan('end', short, 640)).toEqual({ startMin: 600, endMin: 645 })
  })
})

describe('columnAt', () => {
  it('finds the day under the pointer and clamps outside the week', () => {
    expect(columnAt(150, 100, 700, 7)).toBe(0)
    expect(columnAt(420, 100, 700, 7)).toBe(3)
    expect(columnAt(50, 100, 700, 7)).toBe(0)
    expect(columnAt(900, 100, 700, 7)).toBe(6)
    expect(columnAt(900, 100, 700, 1)).toBe(0)
  })
})

describe('slotAt', () => {
  it('takes the quarter the click falls in, leaving room before midnight', () => {
    expect(slotAt(9 * 60 + 14)).toBe(540)
    expect(slotAt(9 * 60 + 15)).toBe(555)
    expect(slotAt(1439)).toBe(1425)
  })
})

describe('edgePx', () => {
  it('six pixels, less on short blocks, none on tiny ones', () => {
    expect(edgePx(60)).toBe(6)
    expect(edgePx(16)).toBe(4)
    expect(edgePx(8)).toBe(0)
  })
})
