/**
 * ★ The only file in the frontend that touches window.api. ★
 *
 * Every component and hook imports `api` from here. That single indirection is what lets
 * the same React code run against:
 *   - the Electron backend (window.api, injected by the preload bridge)
 *   - a mock implementation, for building UI without a running backend
 *   - an HTTP client, for a read-only supervisor view reading the published payloads
 *
 * If you find yourself reaching for window.api anywhere else, that is the bug.
 */

import type { TimeTrackerAPI } from '@core/contract/api.js'
import type { AppEventBus } from '@core/contract/events.js'

import { playCue, type Cue } from '../lib/cues.js'

declare global {
  interface Window {
    api?: TimeTrackerAPI
    events?: AppEventBus
  }
}

const missing = (): never => {
  throw new Error(
    'The backend bridge is not available. This page was loaded outside Electron, or the ' +
      'preload script failed — check the main process log.'
  )
}

/** Present in the desktop app; absent when the page is opened standalone. */
export const isBackendAvailable = (): boolean => typeof window !== 'undefined' && !!window.api

/**
 * The calls that make a sound once they succeed. Here, at the one door every screen goes
 * through, so a timer started from the switcher sounds the same as one started from Today —
 * and a change that arrives through sync from the other device stays quiet.
 */
const CUED: Record<string, Record<string, (args: unknown[]) => Cue | null>> = {
  tracking: {
    startRun: () => 'start',
    switchTask: () => 'start',
    stopRun: () => 'stop',
    completeAndSwitch: () => 'done'
  },
  tasks: { complete: (args) => (args[1] ? 'done' : null) }
}

const withCues = (domain: string, methods: unknown): unknown => {
  const cued = CUED[domain]
  if (!cued || !methods) return methods
  const target = methods as Record<string, unknown>
  // An empty stand-in, not the bridge object itself: a frozen bridge object would forbid a
  // Proxy from handing back a wrapped method.
  return new Proxy({}, {
    get(_stand, name: string) {
      const method = target[name]
      const cueOf = cued[name]
      if (!cueOf || typeof method !== 'function') return method
      return async (...args: unknown[]) => {
        const result = await (method as (...a: unknown[]) => Promise<unknown>).apply(target, args)
        const cue = cueOf(args)
        if (cue) playCue(cue)
        return result
      }
    }
  })
}

export const api: TimeTrackerAPI = new Proxy({} as TimeTrackerAPI, {
  get(_target, domain: string) {
    const backend = window.api as unknown as Record<string, unknown> | undefined
    if (!backend) missing()
    return withCues(domain, backend![domain])
  }
})

export const events: AppEventBus = {
  on(event, handler) {
    if (!window.events) return () => undefined
    return window.events.on(event, handler)
  }
}
