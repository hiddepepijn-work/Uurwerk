import { describe, expect, it } from 'vitest'

import { NUMBER_MS, PHASE_MS, countDuration, frameAt, parseCountable } from './useCountUp.js'

const END = Number.POSITIVE_INFINITY

describe('parseCountable', () => {
  it('reads the duration shapes the app formats', () => {
    expect(parseCountable('4h 35m')).toMatchObject({ kind: 'duration', hours: 4, minutes: 35 })
    expect(parseCountable('18h')).toMatchObject({ kind: 'duration', hours: 18, minutes: null })
    expect(parseCountable('35m')).toMatchObject({ kind: 'duration', hours: null, minutes: 35 })
    expect(parseCountable('4h 05m')).toMatchObject({ kind: 'duration', minutes: 5, pad: true })
  })

  it('reads plain numbers and leaves text alone', () => {
    expect(parseCountable('82%')).toMatchObject({ kind: 'number', value: 82, suffix: '%' })
    expect(parseCountable('3 / 5')).toMatchObject({ kind: 'number', value: 3, suffix: ' / 5' })
    expect(parseCountable('—')).toEqual({ kind: 'text', text: '—' })
    expect(parseCountable('12 Oct')).toEqual({ kind: 'text', text: '12 Oct' })
  })
})

describe('frameAt', () => {
  it('counts hours first, then minutes, never both at once', () => {
    const to = parseCountable('4h 35m')
    expect(frameAt(to, null, 0)).toBe('0h')
    const phase1 = frameAt(to, null, PHASE_MS / 2)
    expect(phase1).toMatch(/^\dh$/)
    expect(frameAt(to, null, PHASE_MS)).toBe('4h 0m')
    const phase2 = frameAt(to, null, PHASE_MS * 1.5)
    expect(phase2).toMatch(/^4h \d+m$/)
    expect(frameAt(to, null, PHASE_MS * 2)).toBe('4h 35m')
    expect(countDuration(to, null)).toBe(PHASE_MS * 2)
  })

  it('counts only the hours for "18h" and only the minutes for "35m"', () => {
    const hours = parseCountable('18h')
    expect(countDuration(hours, null)).toBe(PHASE_MS)
    expect(frameAt(hours, null, PHASE_MS / 2)).toMatch(/^\d+h$/)
    expect(frameAt(hours, null, END)).toBe('18h')

    const minutes = parseCountable('35m')
    expect(countDuration(minutes, null)).toBe(PHASE_MS)
    expect(frameAt(minutes, null, 0)).toBe('0m')
    expect(frameAt(minutes, null, END)).toBe('35m')
  })

  it('keeps the zero-padded minutes of the target', () => {
    expect(frameAt(parseCountable('4h 05m'), null, PHASE_MS)).toBe('4h 00m')
    expect(frameAt(parseCountable('4h 05m'), null, END)).toBe('4h 05m')
  })

  it('on a change within the same hour, only the minutes move', () => {
    const from = parseCountable('4h 35m')
    const to = parseCountable('4h 36m')
    expect(countDuration(to, from)).toBe(PHASE_MS)
    expect(frameAt(to, from, 0)).toBe('4h 35m')
    expect(frameAt(to, from, END)).toBe('4h 36m')
  })

  it('counts plain numbers once and shows text as is', () => {
    const pct = parseCountable('82%')
    expect(countDuration(pct, null)).toBe(NUMBER_MS)
    expect(frameAt(pct, null, 0)).toBe('0%')
    expect(frameAt(pct, null, END)).toBe('82%')
    expect(frameAt(parseCountable('3 / 5'), null, 0)).toBe('0 / 5')
    expect(frameAt(parseCountable('7.5'), null, END)).toBe('7.5')

    const dash = parseCountable('—')
    expect(countDuration(dash, null)).toBe(0)
    expect(frameAt(dash, null, 0)).toBe('—')
  })
})
