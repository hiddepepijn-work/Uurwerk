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
import { Capacitor as Platform } from '@capacitor/core'

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
import { playCue, setCuePlayer } from '@renderer/lib/cues.js'
import '@renderer/styles/fonts.js'
import './styles.css'

import { openPhoneDatabase } from './database.js'
import { onCheckinAnswered, onQuestionTapped, scheduleNotifications, testCueNotifications, type Checkin, type CheckinAnswer } from './notifications.js'
import { liveQueue } from './live.js'
import { AudioFocus, speakEvening, speakMorning } from './speech.js'
import { PhoneSync } from './sync.js'
import { widgetData } from './widget-data.js'
import { FocusGuard } from './focus.js'
import { parseLink } from './links.js'

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
    return upcomingReminders(blocks, backend.calendar.eventsInRange(fromMs, toMs + 86_400_000), fromMs, toMs, (taskId) => backend.store.tasks.get(taskId))
  }
  // A changed plan moves its reminders; batched, because a replan is many writes.
  let rescheduleTimer: ReturnType<typeof setTimeout> | null = null
  const reschedule = (): void => {
    if (rescheduleTimer) clearTimeout(rescheduleTimer)
    rescheduleTimer = setTimeout(() => {
      void scheduleNotifications(reminders).catch(() => undefined)
      refreshLive()
      refreshWidgets()
    }, 5_000)
  }
  // Check-ins on planned tasks. "Gelukt" finishes it; "Ja, bezig" starts the timer if none runs;
  // "Nog niet" on something important brings Jarvis in, who asks why and finds a new moment.
  const answerCheckin = (answer: CheckinAnswer, checkin: Checkin): void => {
    void (async () => {
      const api = window.api!
      console.info(`[jarvis] check-in ${checkin.stage}: ${answer} op "${checkin.task}"${checkin.important ? ' (belangrijk)' : ''}`)
      if (answer === 'done') {
        await api.tasks.complete(checkin.taskId, true)
        emit('notify', { level: 'info', message: `${checkin.task} afgevinkt.` })
        return
      }
      if (answer === 'busy') {
        if (!(await api.tracking.currentRun())) await api.tracking.startRun(checkin.taskId)
        emit('notify', { level: 'info', message: `Top, de timer loopt op ${checkin.task}.` })
        return
      }
      if (answer === 'notyet' || answer === 'notdone') {
        if (!checkin.important) {
          emit('notify', { level: 'info', message: `Oké. ${checkin.task} blijft staan.` })
          return
        }
        const why = checkin.stage === 'midway' ? `nog niet bezig is met "${checkin.task}", terwijl het nu gepland staat` : `"${checkin.task}" nog niet af heeft, terwijl het blok voorbij is`
        emit('jarvis:open', {
          moment: null,
          prompt: `(Check-in. Hidde zegt dat hij ${why}. Het is belangrijk. Vraag kort en streng waarom, één vraag, en spreek daarna een nieuw moment af: schedule_task met move true, of unschedule_task als het echt niet meer hoeft.)`
        })
        return
      }
      emit('ui:open', { target: 'tasks' })
    })()
  }

  /**
   * The Live Activity: first apply what was pressed on it while the app slept (✓ and ▶ work
   * without opening the app), then hand over the queue it picks from.
   */
  let liveBusy = false
  const refreshLive = (): void => {
    if (liveBusy || !window.api) return
    liveBusy = true
    void (async () => {
      const { answers } = await AudioFocus.liveTake()
      for (const { answer, taskId, at } of answers) {
        const task = backend.store.tasks.get(taskId)
        if (!task) continue
        // Started again after that tap (an accidental Klaar, say): the tap is out of date.
        const segment = backend.trackingService.currentSegment()
        if (answer === 'done' && segment?.taskId === taskId && segment.startedAt > at) continue
        if (answer === 'done' && task.status !== 'done') await window.api!.tasks.complete(taskId, true)
        if (answer === 'busy' && !(await window.api!.tracking.currentRun())) await window.api!.tracking.startRun(taskId)
      }
      const running = await window.api!.tracking.currentRun()
      const segment = running?.segments.at(-1)
      const current = segment?.taskId ? { taskId: segment.taskId, startedAt: segment.startedAt } : null
      await AudioFocus.liveCheckin({ json: JSON.stringify(liveQueue(backend, current)) })
    })()
      .catch(() => undefined)
      .finally(() => (liveBusy = false))
  }

  /** The home-screen widgets read what this writes; a failure only means stale widgets. */
  let widgetProblemShown = false
  const refreshWidgets = (): void => {
    try {
      void AudioFocus.setWidgetData({ json: widgetData(backend, focus.label()) }).catch((error: unknown) => {
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
    // The lock screen follows the timer at once, not after the 5-second batch.
    if (domain === 'sessions') refreshLive()
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
  onCheckinAnswered(answerCheckin)
  window.events = bus
  window.audioFocus = AudioFocus
  // Talking to Jarvis: the phone's own speech recognition, through the native plugin.
  const subscribe = (event: 'speechPartial' | 'speechEnd' | 'speechLevel', handler: (data: { text?: string; level?: number }) => void) => {
    const pending = AudioFocus.addListener(event, handler)
    return () => void pending.then((listener) => listener.remove())
  }
  if (Platform.isNativePlatform()) window.jarvisListen = {
    start: () => AudioFocus.listenStart({ locale: 'nl-NL' }),
    stop: () => AudioFocus.listenStop(),
    onPartial: (handler) => subscribe('speechPartial', (data) => handler(data.text ?? '')),
    onLevel: (handler) => subscribe('speechLevel', (data) => handler(data.level ?? 0)),
    onEnd: (handler) => subscribe('speechEnd', (data) => handler(data.text ?? ''))
  }

  const focus = new FocusGuard(
    backend,
    (message) => emit('notify', { level: 'info', message }),
    () => refreshWidgets()
  )
  await focus.load()
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

  // The phone plays cues natively: the silent switch turns the sound into just a tap.
  if (Platform.isNativePlatform()) {
    setCuePlayer((cue) => void AudioFocus.cue({ name: cue }).catch(() => undefined))
    window.phoneCues = { test: testCueNotifications }
  }

  console.info('[boot] 4 render')
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )

  await sync.start()

  // Jarvis's trail ("[jarvis] …" lines) goes to the server log every few seconds: the phone
  // keeps no log anyone can read, and a conversation that fails here must leave a trace.
  const trail: string[] = []
  for (const level of ['info', 'warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      original(...args)
      const text = args.map((arg) => (arg instanceof Error ? arg.message : typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')
      if (text.startsWith('[jarvis]')) trail.push(`${new Date().toTimeString().slice(0, 8)} ${text}`)
    }
  }
  setInterval(() => {
    if (trail.length === 0 || !sync.paired) return
    const lines = trail.splice(0, trail.length)
    void window.api!.jarvis.clientLog({ device: 'iphone', lines }).catch(() => trail.unshift(...lines.slice(-30)))
  }, 4000)

  onQuestionTapped((target, moment) => {
    // Jarvis takes the moment when he can; the plain planner and read-out are the fallback
    // for when the server or its keys are not there. A tap on a notification often wakes
    // the phone with no network yet, so he is asked a few times before giving up — and the
    // reason is shown, so a read-out never silently stands in for Jarvis.
    void (async () => {
      console.info(`[jarvis] melding getikt: ${moment}`)
      let problem = ''
      for (const wait of [0, 1500, 3500, 6000]) {
        if (wait) await new Promise((resolve) => setTimeout(resolve, wait))
        try {
          const status = await window.api!.jarvis.status()
          if (status.ready) {
            emit('jarvis:open', { moment })
            return
          }
          problem = status.problem ?? 'Jarvis is niet klaar.'
          break
        } catch (error) {
          problem = error instanceof Error ? error.message : String(error)
          console.info(`[jarvis] status mislukt: ${problem}`)
        }
      }
      console.info(`[jarvis] niet bereikbaar, korte versie: ${problem}`)
      emit('notify', { level: 'warn', message: `Jarvis niet bereikbaar (${problem}); de korte versie in plaats daarvan.` })
      emit('ui:open', { target })
      if (moment === 'morning') void speakMorning(window.api!)
      else void speakEvening(window.api!)
    })()
  })
  void scheduleNotifications(reminders).catch(() => undefined)
  refreshLive()

  // Background: save the copy and hand the changes over while the app still may.
  void Capacitor.addListener('pause', () => {
    void database.flush()
    void sync.round()
    sync.quiet()
  })
  void Capacitor.addListener('resume', () => {
    void sync.round()
    sync.listen()
    void scheduleNotifications(reminders).catch(() => undefined)
    refreshLive()
    refreshWidgets()
  })
  refreshWidgets()

  // The widget buttons (uurwerk://timer, jarvis, task, appointment, agenda) and the
  // Shortcuts automations that open Jarvis at 08:30 and 21:00 (jarvis?moment=morning).
  void Capacitor.addListener('appUrlOpen', ({ url }) => {
    const { action, moment, checkin } = parseLink(url)
    if (action === 'checkin' && checkin) answerCheckin(checkin.answer, checkin)
    else if (action === 'jarvis') emit('jarvis:open', { moment })
    else if (action === 'focus') void focus.toggle()
    else if (action === 'task') emit('ui:open', { target: 'tasks' })
    else if (action === 'appointment') emit('ui:open', { target: 'addEvent' })
    else if (action === 'agenda') emit('ui:open', { target: 'agenda' })
    else if (action === 'timer') {
      const running = backend.trackingService.isRunning()
      void (running ? window.api!.tracking.stopRun() : window.api!.tracking.startRun(null)).then(() => {
        playCue(running ? 'stop' : 'start')
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
