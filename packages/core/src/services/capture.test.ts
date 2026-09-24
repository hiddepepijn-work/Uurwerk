import { describe, expect, it } from 'vitest'
import {
  CAPTURE_PROFILES,
  captureProfile,
  decide,
  estimateStorage,
  matchBlocklist,
  shouldAttempt,
  windowAllows,
  type CaptureTiming
} from './capture.js'

const BLOCKLIST = ['teams', 'zoom', 'outlook', 'bitwarden']

const timing = (patch: Partial<CaptureTiming> = {}): CaptureTiming => ({
  enabled: true,
  tracking: true,
  intervalMin: 5,
  lastCaptureAt: null,
  now: 1_000_000_000,
  idleSec: 0,
  idleTimeoutMin: 5,
  ...patch
})

describe('capture timing', () => {
  it('captures when tracking, enabled, active and the interval has passed', () => {
    expect(shouldAttempt(timing())).toEqual({ capture: true })
  })

  it('never captures while the timer is off', () => {
    expect(shouldAttempt(timing({ tracking: false }))).toMatchObject({
      capture: false,
      reason: 'not-tracking'
    })
  })

  it('never captures when the setting is off, even while tracking', () => {
    expect(shouldAttempt(timing({ enabled: false }))).toMatchObject({
      capture: false,
      reason: 'disabled'
    })
  })

  it('waits out the interval between frames', () => {
    const now = 1_000_000_000
    const justBefore = shouldAttempt(
      timing({ now, lastCaptureAt: now - 5 * 60_000 + 1 })
    )
    const justAfter = shouldAttempt(timing({ now, lastCaptureAt: now - 5 * 60_000 }))

    expect(justBefore).toMatchObject({ capture: false, reason: 'too-soon' })
    expect(justAfter.capture).toBe(true)
  })

  it('skips while you are idle, so a break is not recorded frame after frame', () => {
    expect(shouldAttempt(timing({ idleSec: 5 * 60, idleTimeoutMin: 5 }))).toMatchObject({
      capture: false,
      reason: 'idle'
    })
    expect(shouldAttempt(timing({ idleSec: 5 * 60 - 1, idleTimeoutMin: 5 })).capture).toBe(true)
  })

  it('treats a zero or negative interval as one minute rather than capturing constantly', () => {
    const now = 1_000_000_000
    expect(
      shouldAttempt(timing({ now, intervalMin: 0, lastCaptureAt: now - 30_000 }))
    ).toMatchObject({ capture: false, reason: 'too-soon' })
  })
})

describe('the blocklist', () => {
  it('matches a substring of the window title, case-insensitively', () => {
    expect(matchBlocklist('Chat | Microsoft Teams', BLOCKLIST)).toBe('teams')
    expect(matchBlocklist('Inbox - hidde@example.com - Outlook', BLOCKLIST)).toBe('outlook')
    expect(matchBlocklist('Uurwerk', BLOCKLIST)).toBeNull()
  })

  it('ignores blank entries, which would otherwise match everything', () => {
    expect(matchBlocklist('Visual Studio Code', ['', '   '])).toBeNull()
  })

  it('blocks a password manager', () => {
    expect(windowAllows('Bitwarden - My Vault', BLOCKLIST)).toMatchObject({
      capture: false,
      reason: 'blocklist',
      matched: 'bitwarden'
    })
  })

  it('refuses to capture when the focused window cannot be identified', () => {
    expect(windowAllows(null, BLOCKLIST)).toMatchObject({
      capture: false,
      reason: 'unknown-window'
    })
  })

  it('allows an ordinary window', () => {
    expect(windowAllows('capture.ts — Uurwerk — Visual Studio Code', BLOCKLIST)).toEqual({
      capture: true
    })
  })
})

describe('quality profiles and storage', () => {
  it('never claims a width above what Full HD means', () => {
    expect(CAPTURE_PROFILES.hd.maxWidth).toBe(1920)
    expect(CAPTURE_PROFILES.compact.maxWidth).toBeLessThan(CAPTURE_PROFILES.hd.maxWidth)
  })

  it('falls back to HD for an unknown quality rather than crashing', () => {
    // Settings are merged from stored JSON, so a stale or hand-edited value can arrive.
    expect(captureProfile('nonsense' as never).id).toBe('hd')
  })

  it('estimates the measured cost of one minute of Full HD', () => {
    const cost = estimateStorage('hd', 1)
    expect(cost.framesPerDay).toBe(480)
    // 480 frames x 106 KB is just under 50 MB; the high figure allows for busier screens.
    expect(cost.mbPerDayLow).toBe(50)
    expect(cost.mbPerDayHigh).toBe(75)
    // Just over a gigabyte at worst, and it stops there — that is the whole point of the
    // retention window.
    expect(cost.mbRetainedHigh).toBe(1043)
  })

  it('scales down with a longer interval', () => {
    expect(estimateStorage('hd', 5).framesPerDay).toBe(96)
    expect(estimateStorage('hd', 5).mbPerDayLow).toBeLessThan(estimateStorage('hd', 1).mbPerDayLow)
  })

  it('treats a zero interval as one minute, the same as the timing check does', () => {
    expect(estimateStorage('hd', 0).framesPerDay).toBe(estimateStorage('hd', 1).framesPerDay)
  })
})

describe('the two halves together', () => {
  it('reports the timing reason before ever looking at the window', () => {
    // Not tracking wins over a blocked window: the cheap check runs first and short-circuits.
    expect(decide(timing({ tracking: false }), 'Microsoft Teams', BLOCKLIST)).toMatchObject({
      reason: 'not-tracking'
    })
  })

  it('captures only when both halves agree', () => {
    expect(decide(timing(), 'QGIS', BLOCKLIST)).toEqual({ capture: true })
    expect(decide(timing(), 'Zoom Meeting', BLOCKLIST).capture).toBe(false)
  })
})
