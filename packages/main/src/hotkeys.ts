/**
 * Global hotkeys.
 *
 * These are the app's real interface on a working day — if you have to open the window to
 * log an hour, the app has failed. Everything here is OS-wide, so it works while you are
 * in QGIS, a browser, or anything else.
 *
 * The main process owns the shortcuts but not the layout: anything that needs UI emits a
 * `ui:open` event and lets the renderer decide what that means.
 */

import { globalShortcut } from 'electron'
import type { Hotkeys } from '@core/contract/types.js'
import { log } from './logger.js'

export interface HotkeyActions {
  toggleTracking: () => void
  switchTask: () => void
  quickAdd: () => void
  toggleWindow: () => void
  markScreenshot: () => void
  endOfDay: () => void
}

/** The switch-task shortcut is not in Hotkeys yet; keep the default in one place. */
export const SWITCH_TASK_ACCELERATOR = 'CommandOrControl+Alt+Space'

let registered: string[] = []

/**
 * Registers every shortcut, replacing whatever was registered before.
 *
 * A shortcut another application already owns cannot be taken over; Electron simply
 * returns false. That is logged rather than thrown, because one unavailable combination
 * must not stop the other five from working.
 */
export function registerHotkeys(hotkeys: Hotkeys, actions: HotkeyActions): string[] {
  unregisterHotkeys()

  const bindings: Array<{ accelerator: string; handler: () => void; name: string }> = [
    { accelerator: hotkeys.startStop, handler: actions.toggleTracking, name: 'start/stop' },
    { accelerator: SWITCH_TASK_ACCELERATOR, handler: actions.switchTask, name: 'switch task' },
    { accelerator: hotkeys.quickAdd, handler: actions.quickAdd, name: 'quick add' },
    { accelerator: hotkeys.toggleWindow, handler: actions.toggleWindow, name: 'show/hide' },
    { accelerator: hotkeys.markScreenshot, handler: actions.markScreenshot, name: 'screenshot' },
    { accelerator: hotkeys.endOfDay, handler: actions.endOfDay, name: 'end of day' }
  ]

  const failed: string[] = []

  for (const binding of bindings) {
    if (!binding.accelerator) continue
    try {
      const ok = globalShortcut.register(binding.accelerator, binding.handler)
      if (ok) registered.push(binding.accelerator)
      else failed.push(`${binding.name} (${binding.accelerator})`)
    } catch (error) {
      failed.push(`${binding.name} (${binding.accelerator})`)
      log.warn(`Could not register hotkey for ${binding.name}.`, error)
    }
  }

  log.info(`Registered ${registered.length} global hotkey(s).`)
  if (failed.length > 0) {
    log.warn(`Unavailable — another application already owns them: ${failed.join(', ')}`)
  }

  return failed
}

export function unregisterHotkeys(): void {
  for (const accelerator of registered) globalShortcut.unregister(accelerator)
  registered = []
}

