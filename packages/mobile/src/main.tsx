/**
 * ★ Uurwerk on the iPhone. ★
 *
 * The same app as on the laptop — the same React screens, the same backend, the same
 * database schema — running inside a Capacitor web view:
 *
 *   sql.js        the phone's own full copy of the database (database.ts)
 *   PhoneSync     keeps it in step with the VPS; offline it simply waits (sync.ts)
 *   backend       packages/backend, unchanged, behind a phone host (below)
 *   window.api    the one seam the screens use, exactly as the Electron preload provides it
 *
 * Plus what only a phone does: the 08:30 plan and the 21:00 review with a spoken sound.
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App as Capacitor } from '@capacitor/app'
import { Preferences } from '@capacitor/preferences'

import type { TimeTrackerAPI } from '@core/contract/api.js'
import { CHANNELS } from '@core/contract/channels.js'
import type { AppEventBus, AppEventName, AppEvents } from '@core/contract/events.js'
import { openStoreWith } from '@core/db/index.js'
import { invalidatedDomains } from '@backend/announce.js'
import { createBackendFrom } from '@backend/create.js'
import { installHost, unavailable, type SecretKey } from '@backend/host.js'
import { buildImplementation } from '@backend/implementation.js'
import { isServerOnly } from '@backend/server-only.js'
import { upcomingReminders } from '@core/services/reminders.js'
import { toIsoDate } from '@core/util/time.js'

import { App } from '@renderer/app/App.js'
import './styles.css'

import { openPhoneDatabase } from './database.js'
import { onQuestionTapped, scheduleNotifications } from './notifications.js'
import { AudioFocus, speakEvening, speakMorning } from './speech.js'
import { PhoneSync } from './sync.js'
import { widgetData } from './widget-data.js'
import { FocusGuard } from './focus.js'

// ------------------------------------------------------------------ events

type Handler = (payload: unknown) => void
const handlers = new Map<AppEventName, Set<Handler>>()

function emit<K extends AppEventName>(event: K, payload: AppEvents[K]): void {
  for (const handler of handlers.get(event) ?? []) handler(payload)
}

const bus: AppEventBus = {
  on(event, handler) {
    const set = handlers.get(event) ?? new Set<Handler>()
    set.add(handler as Handler)
    handlers.set(event, set)
    return () => set.delete(handler as Handler)
  }
}

// ------------------------------------------------------------------- start

async function start(): Promise<void> {
  console.info('[boot] 1 open db')
  const database = await openPhoneDatabase()
  console.info('[boot] 2 db open')
  const backend = createBackendFrom(openStoreWith(database.driver))
  console.info('[boot] 3 backend')
  const sync = new PhoneSync(backend.store.db, (tables) => {
    for (const domain of invalidatedDomains(tables)) emit('data:invalidated', { domain })
  })

  // Secrets on the phone: only the SMTP password could ever be set here, and mail goes out
  // from the server. Kept in memory and Preferences so the Settings screen still works.
  const vault = new Map<string, string>()
  const secrets = {
    get: (key: SecretKey) => vault.get(key) ?? null,
    has: (key: SecretKey) => vault.has(key),
    set: (key: SecretKey, value: string) => {
      if (value) vault.set(key, value)
      else vault.delete(key)
      void Preferences.set({ key: `secret:${key}`, value })
    }
  }

  installHost({
    emit(event, payload) {
      emit(event, payload)
      if (event === 'data:invalidated') sync.nudge()
    },
    secrets,
    reportDir: () => '',
    openPath: unavailable('Opening a file'),
    openExternal: async (url) => {
      window.open(url, '_system')
    },
    showItemInFolder: () => undefined,
    capture: {
      markNow: unavailable('Taking a screenshot'),
      buildTimelapse: unavailable('Encoding a timelapse')
    },
    startup: {
      getLoginItemStatus: async () => ({
        enabled: false,
        registered: false,
        supported: false,
        reason: 'Not on a phone.'
      }),
      setAutoLaunch: unavailable('Start with Windows')
    },
    window: {
      minimizeToTray: async () => undefined,
      closeQuickAdd: async () => undefined,
      quit: async () => undefined
    },
    relaunch: async () => window.location.reload(),
    sync: {
      status: async () => sync.status(),
      pair: (url, token, mode) => sync.pair(url, token, mode),
      now: async () => {
        await sync.round()
        return sync.status()
      },
      unpair: () => sync.unpair()
    },
    fileFor: (artifact) => artifact.path
  })

  /** The reminders for a window, read straight from this copy of the database. */
  const reminders = (fromMs: number, toMs: number) => {
    const blocks = []
    for (let day = fromMs; day < toMs + 86_400_000; day += 86_400_000) {
      const plan = backend.store.plans.accepted('day', toIsoDate(day))
      if (plan) blocks.push(...backend.store.plans.blocks(plan.id))
    }
    return upcomingReminders(blocks, backend.calendar.eventsInRange(fromMs, toMs + 86_400_000), fromMs, toMs)
  }
  // A changed plan moves its reminders; batched, because a replan is many writes.
  let rescheduleTimer: ReturnType<typeof setTimeout> | null = null
  const reschedule = (): void => {
    if (rescheduleTimer) clearTimeout(rescheduleTimer)
    rescheduleTimer = setTimeout(() => {
      void scheduleNotifications(reminders).catch(() => undefined)
      refreshWidgets()
    }, 5_000)
  }
  /** The home-screen widgets read what this writes; a failure only means stale widgets. */
  let widgetProblemShown = false
  const refreshWidgets = (): void => {
    try {
      void AudioFocus.setWidgetData({ json: widgetData(backend) }).catch((error: unknown) => {
        // Said once per start: an empty widget with no reason given is impossible to fix.
        if (widgetProblemShown) return
        widgetProblemShown = true
        emit('notify', { level: 'warn', message: error instanceof Error ? error.message : String(error) })
      })
    } catch {
      // Nothing to show is better than a crash at start.
    }
  }
  bus.on('data:invalidated', ({ domain }) => {
    if (domain === 'planning' || domain === 'tasks' || domain === 'sessions') reschedule()
    if (domain === 'tasks') void focus.check()
  })

  // Deliberately no repairOnStartup(): an open segment here may be the laptop's timer,
  // running right now, and closing it would stop the clock on the other machine.

  const implementation = buildImplementation(backend) as unknown as Record<
    string,
    Record<string, (...args: unknown[]) => Promise<unknown>>
  >
  const api: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> = {}
  for (const [domain, methods] of Object.entries(CHANNELS)) {
    api[domain] = {}
    for (const method of methods as readonly string[]) {
      api[domain]![method] = async (...args) =>
        sync.paired && isServerOnly(domain, method)
          ? sync.forward(domain, method, args)
          : implementation[domain]![method]!(...args)
    }
  }
  window.api = api as unknown as TimeTrackerAPI
  window.events = bus
  window.audioFocus = AudioFocus

  const focus = new FocusGuard(backend, (message) => emit('notify', { level: 'info', message }))
  backend.trackingService.onChange((segment, reason) => {
    if (reason === 'start' || reason === 'switch') void focus.onTaskStarted(segment?.taskId ?? null)
    emit('tracking:segmentChanged', { segment, reason })
    emit('data:invalidated', { domain: 'sessions' })
    if (reason === 'complete' || reason === 'start' || reason === 'switch') {
      emit('data:invalidated', { domain: 'tasks' })
    }
  })
  setInterval(() => {
    const running = backend.trackingService.currentSegment()
    if (running) {
      emit('timer:tick', { sessionId: running.id, elapsedSec: Math.floor((Date.now() - running.startedAt) / 1000) })
    }
  }, 1000)

  console.info('[boot] 4 render')
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )

  await sync.start()

  onQuestionTapped((target, moment) => {
    // Jarvis takes the moment when he can; the plain planner and read-out are the fallback
    // for when the server or its keys are not there.
    void window.api!.jarvis
      .status()
      .then((status) => {
        if (!status.ready) throw new Error(status.problem ?? 'not ready')
        emit('jarvis:open', { moment })
      })
      .catch(() => {
        emit('ui:open', { target })
        if (moment === 'morning') void speakMorning(window.api!)
        else void speakEvening(window.api!)
      })
  })
  void scheduleNotifications(reminders).catch(() => undefined)

  // Background: save the copy and hand the changes over while the app still may.
  void Capacitor.addListener('pause', () => {
    void database.flush()
    void sync.round()
  })
  void Capacitor.addListener('resume', () => {
    void sync.round()
    void scheduleNotifications(reminders).catch(() => undefined)
    refreshWidgets()
  })
  refreshWidgets()

  // The widget buttons: uurwerk://timer, jarvis, task, appointment, agenda.
  void Capacitor.addListener('appUrlOpen', ({ url }) => {
    const action = url.replace('uurwerk://', '').split(/[/?#]/)[0]
    if (action === 'jarvis') emit('jarvis:open', { moment: null })
    else if (action === 'task') emit('ui:open', { target: 'tasks' })
    else if (action === 'appointment') emit('ui:open', { target: 'addEvent' })
    else if (action === 'agenda') emit('ui:open', { target: 'agenda' })
    else if (action === 'timer') {
      const running = backend.trackingService.isRunning()
      void (running ? window.api!.tracking.stopRun() : window.api!.tracking.startRun(null)).then(() => {
        emit('ui:open', { target: 'today' })
        refreshWidgets()
      })
    }
  })
}

void start().catch((error: unknown) => {
  document.getElementById('root')!.innerHTML = `<pre style="padding:24px;white-space:pre-wrap;color:#f88">Uurwerk kon niet starten:\n${
    error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  }</pre>`
})
