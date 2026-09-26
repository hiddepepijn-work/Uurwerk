import { describe, expect, it } from 'vitest'
import { needsFocus } from './focus.js'

describe('focus', () => {
  it('always for stage work', () => {
    expect(needsFocus({ focusMode: 'auto', areaId: 'stage', estimateMin: 10 })).toBe(true)
  })

  it('for private work only when it is a real job', () => {
    expect(needsFocus({ focusMode: 'auto', areaId: 'personal', estimateMin: 60 })).toBe(true)
    expect(needsFocus({ focusMode: 'auto', areaId: 'personal', estimateMin: 10 })).toBe(false)
    expect(needsFocus({ focusMode: 'auto', areaId: 'personal', estimateMin: null })).toBe(false)
  })

  it('lets a task override the rule either way', () => {
    expect(needsFocus({ focusMode: 'never', areaId: 'stage', estimateMin: 120 })).toBe(false)
    expect(needsFocus({ focusMode: 'always', areaId: 'personal', estimateMin: 5 })).toBe(true)
  })
})
