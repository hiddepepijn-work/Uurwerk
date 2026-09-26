/**
 * Application entry point.
 *
 * Startup order: single instance → hardened session → database and migrations → IPC →
 * tray → global hotkeys → repair anything left open by the previous run → window.
 *
 * Two things startup deliberately does NOT do: start a timer, and publish anything.
 * Launching at sign-in means "be available", not "assume I am working".
 */

import { app, BrowserWindow, powerMonitor, session } from 'electron'
import { decideResume, type ArmedResume } from '@core/services/idle-resume.js'
import { createBackend, type Backend } from '@backend/create.js'
import { installHost } from '@backend/host.js'
import { finishAdoption, swapInDownloadedCopy, SyncClient } from '@backend/sync-client.js'
import { emitEvent } from './events.js'
import { electronHost } from './host.js'
import { registerIpc } from './ipc.js'
import { dbPath } from './paths.js'
import { captureNow, startCapture, stopCapture } from './capture.js'
import { cancelTimelapse } from './timelapse.js'
import { createMainWindow, createQuickAddWindow } from './windows.js'
import { registerHotkeys, unregisterHotkeys } from './hotkeys.js'
import { createTray, destroyTray, update as updateTray } from './tray.js'
import { startMorningCheck, stopMorningCheck } from './morning.js'
import { startReminders, stopReminders } from './reminders.js'
import { startFocusGuard, stopFocusGuard } from './focus-guard.js'
import { startScreenTime, stopScreenTime } from './screen-time.js'
import { syncAllAccounts } from '@backend/calendar/index.js'
import { applyAutoLaunch, launchedAtLogin } from './startup.js'
import { log } from './logger.js'

let backend: Backend | null = null
let syncClient: SyncClient | null = null
let mainWindow: BrowserWindow | null = null
let quickAddWindow: BrowserWindow | null = null
let tickHandle: NodeJS.Timeout | null = null
let idleHandle: NodeJS.Timeout | null = null
let calendarHandle: NodeJS.Timeout | null = null
/**
 * The task an idle stop interrupted, waiting for you to come back.
 *
 * Deliberately in memory only: a resume that survives a restart would mean opening the app
 * tomorrow and finding the timer running on yesterday's task.
 */
let armedResume: ArmedResume | null = null

/** Distinguishes "close the window" from "quit the app" — the tray keeps us alive. */
let quitting = false

// A second launch (double-clicked shortcut, scheduler job) must focus the running app,
// never open a second one — two instances would mean two writers on one database.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())
  void app.whenReady().then(start)
}

function start(): void {
  applyContentSecurityPolicy()

  // A copy downloaded from the server while pairing is swapped in before anything opens it.
  swapInDownloadedCopy(dbPath())
  backend = createBackend(dbPath())
  syncClient = new SyncClient(backend, dbPath())
  installHost(electronHost(backend, syncClient))
  finishAdoption(backend)
  const settings = backend.store.settings.get()

  // Runs and segments left open by a crash are closed here rather than carried into
  // today's total — an open row keeps counting until now, however long ago it was written.
  const repaired = backend.trackingService.repairOnStartup()
  if (repaired > 0) log.warn(`Repaired ${repaired} unfinished run(s) or segment(s) from a previous run.`)

  // Rebinding a hotkey in Settings has to take effect immediately, not next launch.
  registerIpc(backend, syncClient, () => setupHotkeys())
  // Offline first: the app is fully usable before, and without, the first round.
  syncClient.start()
  setupTray()
  setupHotkeys()
  applyAutoLaunch(settings.autoLaunch)

  // Launching at sign-in stays in the tray unless the setting says otherwise.
  const startHidden = launchedAtLogin() && settings.startupBehaviour === 'tray'
  if (startHidden) {
    log.info('Started in the tray (launched at sign-in).')
  } else {
    mainWindow = createMainWindow()
    attachCloseToTray(mainWindow)
  }

  startTimerTick()
  startIdleWatchdog()
  // Asks once, in the morning, only when the day has no accepted plan. It opens nothing by
  // itself — clicking the notification is what brings the planner up.
  startMorningCheck(backend, () => openInWindow('planDay'))
  startReminders(backend, () => openInWindow('today'))
  startFocusGuard(backend)
  // Counts wall-clock minutes while the machine is awake — independent of the timer, and
  // the only figure here that says anything when you are not tracking.
  startScreenTime(backend)
  startCalendarSync(backend)
  // Capture follows tracking, so the loop is safe to start here: with no run open it does
  // nothing but read a settings row every ten seconds.
  startCapture(backend)

  // Keep the tray in step with tracking, wherever the change came from.
  backend.trackingService.onChange((segment, reason) => {
    updateTray(segment, segment ? Math.floor((Date.now() - segment.startedAt) / 1000) : 0)

    // Anything you did yourself is newer information than the pause that armed a resume.
    // Without this, stopping the timer deliberately in the half-minute after an idle stop
    // would be undone by the very next watchdog tick.
    if (reason !== 'idle') armedResume = null
  })

  app.on('activate', () => showMainWindow())
  log.info('Uurwerk started.')
}

// ------------------------------------------------------------------ windows

function showMainWindow(): BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow()
    attachCloseToTray(mainWindow)
    return mainWindow
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  return mainWindow
}

/** Closing the window hides it; only Quit actually ends the app. */
function attachCloseToTray(window: BrowserWindow): void {
  window.on('close', (event) => {
    if (quitting) return
    if (!backend?.store.settings.get().closeToTray) return
    event.preventDefault()
    window.hide()
  })
}

/** Brings the window forward and tells the renderer what to open once it is there. */
function openInWindow(target: 'switcher' | 'endOfDay' | 'today' | 'tasks' | 'planDay'): void {
  showMainWindow()
  // A window created a moment ago has not loaded yet; wait for it before shouting.
  const send = (): void => emitEvent('ui:open', { target })
  if (mainWindow && mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once('did-finish-load', () => setTimeout(send, 60))
  } else {
    send()
  }
}

function toggleQuickAdd(): void {
  if (!quickAddWindow || quickAddWindow.isDestroyed()) {
    quickAddWindow = createQuickAddWindow()
  }
  if (quickAddWindow.isVisible()) {
    quickAddWindow.hide()
    return
  }
  quickAddWindow.center()
  quickAddWindow.show()
  quickAddWindow.focus()
}

// ------------------------------------------------------- tray and hotkeys

function setupTray(): void {
  createTray({
    toggleTracking: () => {
      if (!backend) return
      if (backend.trackingService.isRunning()) backend.trackingService.stopRun()
      else startUntasked()
    },
    switchTask: () => openInWindow('switcher'),
    quickAdd: () => toggleQuickAdd(),
    showWindow: () => showMainWindow(),
    endOfDay: () => openInWindow('endOfDay'),
    quit: () => {
      quitting = true
      app.quit()
    }
  })
}

/**
 * Starts the clock without asking what you are working on.
 *
 * This is the hotkey's whole value: it fires while you are in QGIS or a browser, and any
 * version of it that first raises a window and demands a task is a version you stop using
 * by the second week. What the stretch was gets divided over tasks at end of day.
 */
function startUntasked(): void {
  if (!backend) return
  backend.trackingService.startRun(null)
  emitEvent('notify', { level: 'info', message: 'Tracking started. Assign tasks at end of day.' })
}

function setupHotkeys(): void {
  if (!backend) return
  const { hotkeys } = backend.store.settings.get()

  const failed = registerHotkeys(hotkeys, {
    toggleTracking: () => {
      if (!backend) return
      if (backend.trackingService.isRunning()) backend.trackingService.stopRun()
      else startUntasked()
    },
    switchTask: () => openInWindow('switcher'),
    quickAdd: () => toggleQuickAdd(),
    toggleWindow: () => {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) mainWindow.hide()
      else showMainWindow()
    },
    markScreenshot: () => {
      void captureNow()
    },
    endOfDay: () => openInWindow('endOfDay')
  })

  if (failed.length > 0) {
    log.warn(`Some hotkeys are already owned by other software: ${failed.join(', ')}`)
  }
}

// ------------------------------------------------------------------ security

/**
 * A strict CSP on top of contextIsolation and sandbox. The renderer loads nothing from the
 * network by design, so everything except its own origin is denied outright.
 * 'unsafe-inline' for styles is what the dev server and Tailwind's injected styles need;
 * scripts get no such exemption.
 */
function applyContentSecurityPolicy(): void {
  const devServer = process.env['ELECTRON_RENDERER_URL']
  const scriptSrc = devServer ? `'self' 'unsafe-inline' ${devServer}` : `'self'`
  const connectSrc = devServer ? `'self' ${devServer} ws://localhost:*` : `'self'`

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            `default-src 'self'`,
            `script-src ${scriptSrc}`,
            `style-src 'self' 'unsafe-inline'`,
            `img-src 'self' data: blob: file:`,
            `media-src 'self' blob: file:`,
            `font-src 'self' data:`,
            `connect-src ${connectSrc}`,
            `object-src 'none'`,
            `frame-src 'none'`,
            `base-uri 'none'`,
            `form-action 'none'`
          ].join('; ')
        ]
      }
    })
  })

  // Nothing in this app needs a camera, a microphone or your location.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    log.warn(`Denied a permission request from the renderer: ${permission}`)
    callback(false)
  })
}

// ------------------------------------------------------------------- loops

/** One event per second while a segment runs — the frontend never polls for the clock. */
function startTimerTick(): void {
  let lastTrayUpdate = 0

  tickHandle = setInterval(() => {
    const running = backend?.trackingService.currentSegment()
    if (!running) return

    const elapsedSec = Math.floor((Date.now() - running.startedAt) / 1000)
    emitEvent('timer:tick', { sessionId: running.id, elapsedSec })

    // Once a minute: refresh the tray, and let the stat cards and timeline catch up so
    // they grow while you work instead of only when something else changes.
    if (elapsedSec - lastTrayUpdate >= 60) {
      lastTrayUpdate = elapsedSec
      updateTray(running, elapsedSec)
      emitEvent('data:invalidated', { domain: 'sessions' })
    }
  }, 1000)
}

/**
 * Keeps subscribed calendars fresh on their own.
 *
 * Once shortly after launch — the calendar you want to see is today's, and waiting twenty
 * minutes for it is the same as not having it — and then on the interval from settings.
 * A failure is recorded on the account and never thrown here: a calendar that cannot be
 * reached must not take the timer, the tray or anything else down with it.
 */
function startCalendarSync(instance: Backend): void {
  const settings = instance.store.settings.get()
  if (!settings.calendarAutoSync) return

  const run = (): void => {
    if (!backend?.store.settings.get().calendarAutoSync) return
    // Paired, the server syncs the calendars; doing it here too would import twice.
    if (syncClient?.paired) return
    void syncAllAccounts(backend).catch((error: unknown) =>
      log.warn('Calendar auto-sync failed.', error)
    )
  }

  // Not immediately: startup is busy enough, and the first fetch can take seconds.
  setTimeout(run, 20_000)
  calendarHandle = setInterval(run, Math.max(5, settings.calendarSyncEveryMin) * 60_000)
}

/**
 * The idle watchdog, which now does two jobs.
 *
 * Going away stops the timer, backdated to when you stopped touching the keyboard, so the
 * gap is never billed. Coming back starts it again on the same task, counting from the
 * moment you returned — because the alternative is a timer that sits off while you work,
 * which loses far more time than idle ever did.
 *
 * The rules for the second half live in core (`decideResume`) where they can be tested;
 * this only supplies the readings and carries out the answer.
 */
function startIdleWatchdog(): void {
  idleHandle = setInterval(() => {
    if (!backend) return

    const { idleTimeoutMin, resumeAfterIdle } = backend.store.settings.get()
    const idleSeconds = powerMonitor.getSystemIdleTime()

    if (backend.trackingService.isRunning()) {
      const stopped = backend.trackingService.handleIdle(idleSeconds, idleTimeoutMin)
      if (!stopped) return

      // Remember what was running, so returning can pick up the same task rather than
      // asking you to find it again. Only an idle stop arms this.
      armedResume = stopped.taskId ? { taskId: stopped.taskId, at: Date.now() } : null

      log.info('Tracking auto-stopped after idle.', { idleSeconds, segmentId: stopped.id })
      emitEvent('notify', {
        level: 'info',
        message: resumeAfterIdle
          ? `Timer paused — ${idleTimeoutMin} minutes idle. The idle time was not counted, and it will pick up where it left off when you are back.`
          : `Timer paused — ${idleTimeoutMin} minutes idle. The idle time was not counted.`
      })
      return
    }

    const decision = decideResume({
      armed: armedResume,
      enabled: resumeAfterIdle,
      running: false,
      idleSeconds,
      now: Date.now()
    })

    if (decision.action === 'expire') {
      armedResume = null
      return
    }
    if (decision.action === 'wait') return

    const task = backend.store.tasks.get(decision.taskId)
    armedResume = null

    // The task may have been finished or deleted while you were away; resuming a task that
    // is done would quietly reopen work you already closed.
    if (!task || task.status === 'done' || task.status === 'archived') return

    backend.trackingService.startRun(task.id)
    log.info('Tracking resumed on the same task after idle.', { taskId: task.id })
    emitEvent('notify', {
      level: 'info',
      message: `Welcome back — tracking “${task.title}” again. The time you were away was not counted.`
    })
  }, 30_000)
}

// ---------------------------------------------------------------- lifecycle

app.on('window-all-closed', () => {
  // The app lives in the tray; closing the window is not quitting.
  if (backend?.store.settings.get().closeToTray) return
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  quitting = true
  if (tickHandle) clearInterval(tickHandle)
  if (idleHandle) clearInterval(idleHandle)
  if (calendarHandle) clearInterval(calendarHandle)
  syncClient?.stop()
  stopMorningCheck()
  stopReminders()
  stopFocusGuard()
  stopScreenTime()
  stopCapture()
  // A half-encoded timelapse holds a hidden window open, which would keep the app alive.
  cancelTimelapse()
  unregisterHotkeys()
  destroyTray()
  // Close any running run so tomorrow does not inherit today's timer.
  backend?.trackingService.stopRun()
  backend?.store.db.close()
  log.info('Uurwerk stopped.')
})
