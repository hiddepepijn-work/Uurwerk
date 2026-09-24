/**
 * Windows startup registration.
 *
 * Two rules that matter more than the feature itself:
 *
 *   1. Only a packaged build may register itself. In development the executable is
 *      Electron's own binary inside node_modules with the project path as an argument —
 *      registering that would put `electron.exe .` in the user's startup list, pointing at
 *      a folder that may move or be deleted. The setting is still stored and shown, it is
 *      simply not applied until the app is installed.
 *   2. Launching at login never starts a timer and never publishes anything. Startup means
 *      "be available", not "assume I am working".
 */

import { app } from 'electron'
import { log } from './logger.js'

export interface LoginItemStatus {
  /** What the setting says the user wants. */
  enabled: boolean
  /** Whether the OS actually has us registered right now. */
  registered: boolean
  /** False in development, where registering would point at a throwaway path. */
  supported: boolean
  reason: string | null
}

const isSupported = (): boolean => app.isPackaged && process.platform === 'win32'

export function getLoginItemStatus(desired: boolean): LoginItemStatus {
  if (!isSupported()) {
    return {
      enabled: desired,
      registered: false,
      supported: false,
      reason: app.isPackaged
        ? 'Starting at sign-in is only supported on Windows.'
        : 'Starting at sign-in applies to the installed app, not to a development run.'
    }
  }

  const settings = app.getLoginItemSettings()
  return {
    enabled: desired,
    registered: settings.openAtLogin,
    supported: true,
    reason: null
  }
}

/**
 * Applies the setting to the OS. Safe to call on every launch — it only writes when the
 * registration does not already match.
 */
export function applyAutoLaunch(enabled: boolean): LoginItemStatus {
  if (!isSupported()) {
    log.info(`Auto-launch not applied (${app.isPackaged ? 'unsupported platform' : 'development run'}).`)
    return getLoginItemStatus(enabled)
  }

  const current = app.getLoginItemSettings().openAtLogin
  if (current !== enabled) {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      // Start hidden: the tray is the startup surface, not a window in your face.
      args: ['--startup']
    })
    log.info(`Auto-launch ${enabled ? 'enabled' : 'disabled'}.`)
  }

  return getLoginItemStatus(enabled)
}

/** True when this launch came from the Windows login item rather than from a click. */
export const launchedAtLogin = (): boolean =>
  process.argv.includes('--startup') || app.getLoginItemSettings().wasOpenedAtLogin
