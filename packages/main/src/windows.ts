/**
 * Window creation, hardened by default.
 *
 * Every window in the app is created here so the security flags are set in exactly one
 * place: contextIsolation on, nodeIntegration off, sandbox on, external navigation blocked.
 * These are set at scaffold time on purpose — retrofitting them later is how Electron apps
 * end up shipping with nodeIntegration quietly left on.
 */

import { BrowserWindow, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { log } from './logger.js'

const PRELOAD = join(__dirname, '../preload/index.cjs')
/** The encoder window gets a far narrower bridge than the app does. */
const TIMELAPSE_PRELOAD = join(__dirname, '../preload/timelapse.cjs')

const BG = '#0B0D0F'

/**
 * Window icon. In a packaged build the icon is baked in by the installer, but in a dev or
 * preview run Electron would otherwise show its own default — so point at resources/.
 */
function appIcon(): string | undefined {
  for (const candidate of [
    join(__dirname, '../../resources/icon.ico'),
    join(process.cwd(), 'resources/icon.ico')
  ]) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

const baseWebPreferences = {
  preload: PRELOAD,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  spellcheck: false
} as const

type Page = 'index' | 'quickadd' | 'timelapse'

/** Renderer entry URLs differ between `electron-vite dev` and a packaged build. */
function rendererUrl(page: Page): { url?: string; file?: string } {
  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer) return { url: `${devServer}/${page === 'index' ? '' : `${page}.html`}` }
  return { file: join(__dirname, `../renderer/${page}.html`) }
}

function load(window: BrowserWindow, page: Page): void {
  const target = rendererUrl(page)
  if (target.url) void window.loadURL(target.url)
  else void window.loadFile(target.file!)
}

/**
 * Nothing in this app should ever navigate away from its own pages, and nothing should
 * open a second window. Links go to the system browser instead.
 */
function lockDownNavigation(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    const devServer = process.env['ELECTRON_RENDERER_URL']
    const isOwnPage = devServer ? url.startsWith(devServer) : url.startsWith('file://')
    if (!isOwnPage) {
      event.preventDefault()
      log.warn('Blocked navigation attempt from the renderer.', url)
    }
  })
}

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: BG,
    icon: appIcon(),
    title: 'Uurwerk',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: BG, symbolColor: '#8A9199', height: 40 },
    webPreferences: baseWebPreferences
  })

  lockDownNavigation(window)
  instrumentLoading(window)
  load(window, 'index')
  return window
}

/**
 * Shows the window, and makes sure a failure to load is visible rather than silent.
 *
 * Waiting only on 'ready-to-show' means that if the renderer fails to load — a bad path, a
 * CSP violation, a syntax error in the bundle — the app runs with no window at all and no
 * clue why. The fallback timer guarantees a window appears either way, and the log says
 * which of the two paths got us there.
 */
function instrumentLoading(window: BrowserWindow): void {
  let shown = false
  const reveal = (how: string): void => {
    if (shown || window.isDestroyed()) return
    shown = true
    window.show()
    log.info(`Main window shown (${how}).`)
  }

  // Whichever comes first. 'ready-to-show' is the documented signal but does not fire
  // reliably on Windows with titleBarOverlay, so 'did-finish-load' is the one that
  // actually gets us on screen; the timer is the last line of defence.
  window.once('ready-to-show', () => reveal('ready-to-show'))
  window.webContents.once('did-finish-load', () => reveal('did-finish-load'))
  setTimeout(() => reveal('fallback timer — the renderer never reported ready'), 4000)

  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    log.error('The renderer failed to load.', { code, description, url })
  })

  window.webContents.on('render-process-gone', (_event, details) => {
    log.error('The renderer process went away.', details)
  })

  window.webContents.on('console-message', (_event, level, message, line, source) => {
    if (level >= 2) log.warn(`Renderer console: ${message}`, { source, line })
  })
}

/**
 * The hidden window that encodes a timelapse.
 *
 * Never shown, never in the taskbar, destroyed the moment the job ends. Two flags matter:
 *
 *   backgroundThrottling: false — Chromium clamps timers to roughly one per second in a
 *     window it thinks nobody is looking at. The encoder paces frames with setTimeout, so
 *     throttling would not merely slow it down, it would stretch every frame to a full
 *     second and produce a one-frame-per-second video regardless of the fps setting.
 *
 *   its own preload — the app's bridge is not exposed here. This page can pull frames the
 *     main process hands it and return a video; it cannot read a task, a session, or a file.
 */
export function createEncoderWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 640,
    height: 400,
    show: false,
    frame: false,
    skipTaskbar: true,
    webPreferences: {
      preload: TIMELAPSE_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
      offscreen: false
    }
  })

  lockDownNavigation(window)
  load(window, 'timelapse')
  return window
}

/** The Ctrl+Alt+T window: small, frameless, always on top, no taskbar entry. */
export function createQuickAddWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 520,
    height: 96,
    show: false,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: BG,
    webPreferences: baseWebPreferences
  })

  lockDownNavigation(window)
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // Losing focus means you moved on; the window should get out of the way by itself.
  window.on('blur', () => window.hide())
  load(window, 'quickadd')
  return window
}
