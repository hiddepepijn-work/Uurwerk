import { describe, expect, it } from 'vitest'

import { HOLD_MS, PressTracker, snapMinute } from './press.js'

describe('PressTracker', () => {
  it('mouse: a click that wobbles a little is still a click', () => {
    const press = new PressTracker()
    press.down('mouse', 100, 100, 0)
    expect(press.move(103, 102, 50).type).toBe('none')
    expect(press.up(103, 102, 120).type).toBe('click')
  })

  it('mouse: moving with the button down drags', () => {
    const press = new PressTracker()
    press.down('mouse', 100, 100, 0)
    expect(press.move(100, 110, 40).type).toBe('drag-start')
    expect(press.move(100, 160, 80).type).toBe('drag-move')
    expect(press.up(100, 160, 100).type).toBe('drag-end')
  })

  it('touch: a tap opens', () => {
    const press = new PressTracker()
    press.down('touch', 50, 50, 0)
    expect(press.up(51, 50, 120).type).toBe('click')
  })

  it('touch: a swipe scrolls and never drags or opens', () => {
    const press = new PressTracker()
    press.down('touch', 50, 50, 0)
    expect(press.move(50, 80, 60).type).toBe('cancel')
    expect(press.move(50, 200, 400).type).toBe('none')
    expect(press.hold(500).type).toBe('none')
    expect(press.up(50, 200, 600).type).toBe('none')
  })

  it('touch: held still, the block is picked up and follows the finger', () => {
    const press = new PressTracker()
    press.down('touch', 50, 50, 0)
    expect(press.hold(HOLD_MS - 50).type).toBe('none')
    expect(press.hold(HOLD_MS).type).toBe('drag-start')
    expect(press.move(50, 120, HOLD_MS + 100).type).toBe('drag-move')
    expect(press.up(50, 120, HOLD_MS + 300).type).toBe('drag-end')
  })

  it('touch: held and let go without moving does nothing', () => {
    const press = new PressTracker()
    press.down('touch', 50, 50, 0)
    press.hold(HOLD_MS)
    expect(press.up(50, 50, HOLD_MS + 200).type).toBe('drag-end')
  })
})

describe('snapMinute', () => {
  it('lands on quarter hours within the day', () => {
    expect(snapMinute(607)).toBe(600)
    expect(snapMinute(608)).toBe(615)
    expect(snapMinute(-20)).toBe(0)
    expect(snapMinute(1500)).toBe(1440)
  })
})
