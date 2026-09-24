/**
 * The backend → frontend broadcast, on its own so nothing has to import ipc.ts to use it.
 *
 * It lived in ipc.ts until capture and timelapse needed it: those two are called *by* ipc.ts
 * and also emit events, which made the import graph a cycle. Splitting the emitter out costs
 * one small file and removes the cycle entirely — the type-only `Backend` import that remains
 * is erased at compile time.
 */

import { BrowserWindow } from 'electron'
import { EVENT_CHANNEL } from '@core/contract/channels.js'
import type { AppEventName, AppEvents } from '@core/contract/events.js'

/** Broadcasts a typed event to every open window. */
export function emitEvent<K extends AppEventName>(event: K, payload: AppEvents[K]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(EVENT_CHANNEL, { event, payload })
  }
}
