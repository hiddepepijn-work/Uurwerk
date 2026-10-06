import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const emitted: Array<[string, unknown]> = []
vi.mock('./host.js', () => ({ emitEvent: (name: string, payload: unknown) => emitted.push([name, payload]) }))

const { SprintTimer } = await import('./sprint.js')

describe('the sprint timer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    emitted.length = 0
  })
  afterEach(() => vi.useRealTimers())

  it('counts down, focuses ten minutes, then rings once', () => {
    const timer = new SprintTimer()
    timer.start()
    expect(emitted[0]).toEqual(['cue:play', { cue: 'countdown' }])
    vi.advanceTimersByTime(5_000)
    expect(timer.status().phase).toBe('focus')
    vi.advanceTimersByTime(10 * 60_000)
    expect(timer.status().phase).toBe('idle')
    expect(emitted.filter(([name, payload]) => name === 'cue:play' && (payload as { cue: string }).cue === 'sprintEnd')).toHaveLength(1)
  })

  it('stops without ringing', () => {
    const timer = new SprintTimer()
    timer.start()
    timer.stop()
    vi.advanceTimersByTime(11 * 60_000)
    expect(emitted.some(([, payload]) => (payload as { cue?: string }).cue === 'sprintEnd')).toBe(false)
  })
})
