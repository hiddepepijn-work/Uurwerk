/**
 * The five-second sprint's clock: five seconds of countdown, then ten minutes of focus.
 *
 * Its own timer, apart from the one that counts hours — nothing is tracked here. It lives in the
 * backend so it keeps time where timers are reliable: the laptop's main process (a hidden
 * window's timers are throttled) and the phone's page (which also schedules a notification for
 * the end, because the page sleeps when the screen locks).
 *
 * Sound is announced, not played: 'cue:play' reaches whatever plays cues on this device.
 */

import { IDLE_SPRINT, SPRINT_COUNTDOWN_MS, SPRINT_FOCUS_MS, sprintAt, sprintFrom, type SprintState } from '@core/domain/sprint.js'

import { emitEvent } from './host.js'

export class SprintTimer {
  private state: SprintState = IDLE_SPRINT
  private timers: Array<ReturnType<typeof setTimeout>> = []

  status(): SprintState {
    return sprintAt(this.state, Date.now())
  }

  /** Starts over, also when one is running: saying it again is starting again. */
  start(): SprintState {
    this.clear()
    this.state = sprintFrom(Date.now())
    emitEvent('cue:play', { cue: 'countdown' })
    emitEvent('sprint:changed', this.state)
    this.timers.push(
      setTimeout(() => emitEvent('sprint:changed', this.status()), SPRINT_COUNTDOWN_MS),
      setTimeout(() => {
        const late = Date.now() - (this.state.endsAt ?? 0) > 5_000
        this.state = IDLE_SPRINT
        // A phone that slept through the end already rang from its notification.
        if (!late) emitEvent('cue:play', { cue: 'sprintEnd' })
        emitEvent('sprint:changed', IDLE_SPRINT)
        emitEvent('notify', { level: 'info', message: 'Tien minuten om. Lekker bezig.' })
      }, SPRINT_COUNTDOWN_MS + SPRINT_FOCUS_MS)
    )
    return this.state
  }

  stop(): SprintState {
    this.clear()
    this.state = IDLE_SPRINT
    emitEvent('sprint:changed', IDLE_SPRINT)
    return IDLE_SPRINT
  }

  private clear(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
  }
}
