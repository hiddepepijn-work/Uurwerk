/**
 * The bridge. This is the entire attack surface between the frontend and the backend.
 *
 * It exposes exactly two things on `window`:
 *   api     — the TimeTrackerAPI methods listed in the channel manifest, nothing else
 *   events  — a subscribe-only event stream
 *
 * No Node, no fs, no ipcRenderer itself. The renderer cannot invoke an arbitrary channel;
 * it can only call the methods generated from the manifest.
 */

import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS, EVENT_CHANNEL, channelName } from '@core/contract/channels.js'
import type { AppEventName, AppEvents } from '@core/contract/events.js'

type Method = (...args: unknown[]) => Promise<unknown>

/** Builds { domain: { method: (...args) => invoke('domain:method', ...args) } }. */
function buildApi(): Record<string, Record<string, Method>> {
  const api: Record<string, Record<string, Method>> = {}

  for (const [domain, methods] of Object.entries(CHANNELS)) {
    api[domain] = {}
    for (const method of methods as readonly string[]) {
      const channel = channelName(domain, method)
      api[domain]![method] = (...args: unknown[]) => ipcRenderer.invoke(channel, ...args)
    }
  }
  return api
}

/**
 * One IPC listener for the whole app, fanned out here.
 *
 * Subscribing per hook adds an ipcRenderer listener per component — the renderer hit
 * Node's ten-listener warning almost immediately and would have leaked steadily as
 * screens mounted and unmounted. The channel is shared, so the subscription should be too.
 */
type Handler = (payload: unknown) => void
const handlers = new Map<AppEventName, Set<Handler>>()
let attached = false

const events = {
  on<K extends AppEventName>(event: K, handler: (payload: AppEvents[K]) => void): () => void {
    if (!attached) {
      attached = true
      ipcRenderer.on(
        EVENT_CHANNEL,
        (_event, message: { event: AppEventName; payload: unknown }) => {
          for (const registered of handlers.get(message.event) ?? []) registered(message.payload)
        }
      )
    }

    const set = handlers.get(event) ?? new Set<Handler>()
    set.add(handler as Handler)
    handlers.set(event, set)

    return () => {
      set.delete(handler as Handler)
      if (set.size === 0) handlers.delete(event)
    }
  }
}

contextBridge.exposeInMainWorld('api', buildApi())
contextBridge.exposeInMainWorld('events', events)
