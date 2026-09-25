/**
 * The laptop as a backend host: a screen to capture, windows to talk to, DPAPI for secrets.
 *
 * Installed once at startup, after the backend exists — the startup and timelapse pieces
 * need the store to read settings from.
 */

import { app, BrowserWindow, shell } from 'electron'

import type { Backend } from '@backend/create.js'
import type { Host } from '@backend/host.js'

import { captureNow } from './capture.js'
import { emitEvent } from './events.js'
import { reportDir } from './paths.js'
import { getSecret, hasSecret, setSecret } from './secrets.js'
import { applyAutoLaunch, getLoginItemStatus } from './startup.js'
import { buildTimelapse } from './timelapse.js'

export function electronHost(backend: Backend): Host {
  return {
    emit: emitEvent,
    secrets: { get: getSecret, set: setSecret, has: hasSecret },
    reportDir,
    openPath: async (path) => {
      await shell.openPath(path)
    },
    openExternal: (url) => shell.openExternal(url),
    showItemInFolder: (path) => shell.showItemInFolder(path),
    capture: {
      markNow: () => captureNow(),
      buildTimelapse: (date) => buildTimelapse(backend, date)
    },
    startup: {
      getLoginItemStatus: async () => getLoginItemStatus(backend.store.settings.get().autoLaunch),
      setAutoLaunch: async (enabled) => applyAutoLaunch(enabled)
    },
    window: {
      minimizeToTray: async () => {
        BrowserWindow.getFocusedWindow()?.hide()
      },
      closeQuickAdd: async () => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isVisible()) continue
          if (window.getSize()[1]! <= 120) window.hide()
        }
      },
      /**
       * The real exit.
       *
       * `app.quit()` rather than closing the window, because the window's own close handler
       * hides it while close-to-tray is on — the whole reason this needs to exist. The
       * `before-quit` handler in index.ts does the shutdown: it stops the open run so the
       * hours are saved, cancels the timers and the capture loop, and closes the database.
       */
      quit: async () => {
        app.quit()
      }
    }
  }
}
