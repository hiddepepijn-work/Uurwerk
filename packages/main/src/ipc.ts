/**
 * ★ The backend, exposed over Electron IPC. ★
 *
 * Every channel in the app is registered from this one file, generated from the manifest in
 * core/contract/channels.ts. If a method is not in that manifest it is not reachable from
 * the renderer — there is no second path in.
 *
 * The methods themselves live in packages/backend, where the server reuses them.
 */

import { ipcMain } from 'electron'

import { CHANNELS, channelName } from '@core/contract/channels.js'
import type { Settings } from '@core/contract/types.js'
import type { Backend } from '@backend/create.js'
import { buildImplementation } from '@backend/implementation.js'

import { emitEvent } from './events.js'
import { log } from './logger.js'

export function registerIpc(
  backend: Backend,
  onSettingsChanged?: (settings: Settings) => void
): void {
  const implementation = buildImplementation(backend, onSettingsChanged) as unknown as Record<
    string,
    Record<string, (...args: unknown[]) => unknown>
  >

  for (const [domain, methods] of Object.entries(CHANNELS)) {
    for (const method of methods as readonly string[]) {
      const channel = channelName(domain, method)
      ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
        try {
          return await implementation[domain]![method]!(...args)
        } catch (error) {
          log.error(`IPC ${channel} failed`, error)
          // Surface a clean message; the stack stays in the log, not in the UI.
          throw new Error(error instanceof Error ? error.message : String(error))
        }
      })
    }
  }

  // The timer is the one thing the frontend must never poll for. Both events fire from
  // the same source of truth: the older `timer:changed` for existing callers, and
  // `tracking:segmentChanged` for anything that needs to know about switching.
  backend.timer.onChange((session, reason) => {
    emitEvent('timer:changed', { session, reason })
  })

  backend.trackingService.onChange((segment, reason) => {
    emitEvent('tracking:segmentChanged', { segment, reason })
    // Stats, the timeline and the task rollups all derive from segments, so any tracking
    // change makes them stale. Without this the cards sat frozen while you worked.
    emitEvent('data:invalidated', { domain: 'sessions' })
    if (reason === 'complete' || reason === 'start' || reason === 'switch') {
      emitEvent('data:invalidated', { domain: 'tasks' })
    }
  })

  log.info(`IPC ready — ${Object.keys(CHANNELS).length} domains registered.`)
}

