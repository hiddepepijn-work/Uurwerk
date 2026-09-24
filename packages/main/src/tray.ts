/**
 * The tray icon.
 *
 * On a working day this is the app: green means a segment is running, grey means nothing
 * is. The window is for planning and reviewing, not for logging time.
 *
 * The two icons come from the same artwork (see scripts/make-icons.ts), so the running and
 * idle states can never drift apart visually.
 */

import { Menu, Tray, nativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { TimeSegment } from '@core/contract/types.js'
import { log } from './logger.js'

export interface TrayActions {
  toggleTracking: () => void
  switchTask: () => void
  quickAdd: () => void
  showWindow: () => void
  endOfDay: () => void
  quit: () => void
}

let tray: Tray | null = null
let actions: TrayActions | null = null

function iconPath(name: string): string | null {
  for (const candidate of [
    join(__dirname, `../../resources/${name}`),
    join(process.cwd(), `resources/${name}`)
  ]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function icon(running: boolean): Electron.NativeImage {
  const path = iconPath(running ? 'tray-running.png' : 'tray-idle.png')
  if (!path) return nativeImage.createEmpty()
  return nativeImage.createFromPath(path)
}

const clock = (seconds: number): string => {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

export function createTray(trayActions: TrayActions): Tray {
  actions = trayActions
  tray = new Tray(icon(false))
  tray.setToolTip('Uurwerk — not tracking')

  // Left click is the fastest possible path back to the window.
  tray.on('click', () => trayActions.showWindow())

  update(null)
  log.info('Tray icon created.')
  return tray
}

/**
 * Reflects the current segment in the icon, the tooltip and the menu.
 * Called on every tracking change and once a minute while a segment runs.
 */
export function update(segment: TimeSegment | null, elapsedSec = 0): void {
  if (!tray || !actions) return

  const running = segment !== null
  const task = segment?.taskTitle ?? 'Unassigned activity'

  tray.setImage(icon(running))
  tray.setToolTip(running ? `Uurwerk — ${task} (${clock(elapsedSec)})` : 'Uurwerk — not tracking')

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: running ? `${task} — ${clock(elapsedSec)}` : 'Not tracking',
        enabled: false
      },
      { type: 'separator' },
      {
        label: running ? 'Stop tracking' : 'Start tracking…',
        click: () => actions!.toggleTracking()
      },
      {
        label: 'Switch task…',
        accelerator: 'CommandOrControl+Alt+Space',
        click: () => actions!.switchTask()
      },
      { label: 'Quick add task…', click: () => actions!.quickAdd() },
      { type: 'separator' },
      { label: 'End of day…', click: () => actions!.endOfDay() },
      { label: 'Open Uurwerk', click: () => actions!.showWindow() },
      { type: 'separator' },
      { label: 'Quit', click: () => actions!.quit() }
    ])
  )
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
