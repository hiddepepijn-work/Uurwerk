import { describe, expect, it } from 'vitest'
import { RESUME_WINDOW_MS, decideResume, type ResumeReading } from './idle-resume.js'

const NOW = Date.parse('2026-08-06T14:00:00')

function reading(overrides: Partial<ResumeReading> = {}): ResumeReading {
  return {
    armed: { taskId: 'task-1', at: NOW - 10 * 60_000 },
    enabled: true,
    running: false,
    idleSeconds: 2,
    now: NOW,
    ...overrides
  }
}

describe('coming back', () => {
  it('resumes the task the pause interrupted', () => {
    expect(decideResume(reading())).toEqual({ action: 'resume', taskId: 'task-1' })
  })

  it('keeps waiting while you are still away', () => {
    // The common case: the watchdog ticks every half minute all through a long lunch.
    expect(decideResume(reading({ idleSeconds: 20 * 60 }))).toEqual({ action: 'wait' })
  })

  it('does nothing when nothing was interrupted', () => {
    expect(decideResume(reading({ armed: null }))).toEqual({ action: 'wait' })
  })
})

describe('what must never resume', () => {
  it('gives up after the window has passed', () => {
    // Back at the desk two and a half hours later: that is a new decision, not a resume.
    const late = reading({ armed: { taskId: 'task-1', at: NOW - RESUME_WINDOW_MS - 60_000 } })
    expect(decideResume(late)).toEqual({ action: 'expire' })
  })

  it('gives up when the setting is off', () => {
    expect(decideResume(reading({ enabled: false }))).toEqual({ action: 'expire' })
  })

  it('gives up when something is already tracking', () => {
    // You started something else yourself; the arm is stale and must not fire later.
    expect(decideResume(reading({ running: true }))).toEqual({ action: 'expire' })
  })

  it('expires rather than waiting, so a stale arm cannot fire hours later', () => {
    // Away, and past the window: it must be forgotten now, not kept until you return.
    const stale = reading({
      idleSeconds: 45 * 60,
      armed: { taskId: 'task-1', at: NOW - RESUME_WINDOW_MS - 1 }
    })
    expect(decideResume(stale)).toEqual({ action: 'expire' })
  })
})

describe('the window edges', () => {
  it('still resumes exactly on the boundary', () => {
    const edge = reading({ armed: { taskId: 'task-1', at: NOW - RESUME_WINDOW_MS } })
    expect(decideResume(edge)).toEqual({ action: 'resume', taskId: 'task-1' })
  })

  it('does not resume one millisecond past it', () => {
    const past = reading({ armed: { taskId: 'task-1', at: NOW - RESUME_WINDOW_MS - 1 } })
    expect(decideResume(past)).toEqual({ action: 'expire' })
  })
})
