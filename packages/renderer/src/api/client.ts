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

export const api: TimeTrackerAPI = new Proxy({} as TimeTrackerAPI, {
  get(_target, domain: string) {
    const backend = window.api as unknown as Record<string, unknown> | undefined
    if (!backend) missing()
    return backend![domain]
  }
})

export const events: AppEventBus = {
  on(event, handler) {
    if (!window.events) return () => undefined
    return window.events.on(event, handler)
  }
}
