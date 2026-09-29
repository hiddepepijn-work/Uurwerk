import { useCallback, useEffect, useState } from 'react'
import { IconRail, type Screen } from './IconRail.js'
import { BottomBar } from './BottomBar.js'
import { JarvisSheet } from '../features/jarvis/JarvisSheet.js'
import { JarvisVoice } from '../features/jarvis/JarvisVoice.js'
import { EventComposer } from '../features/calendar/EventComposer.js'
import { useCompact } from '../hooks/useCompact.js'
import { toIsoDate } from '@core/util/time.js'
import { TopBar } from './TopBar.js'
import { TodayScreen } from '../features/today/TodayScreen.js'
import { TasksScreen } from '../features/tasks/TasksScreen.js'
import { ProjectsScreen } from '../features/projects/ProjectsScreen.js'
import { TaskSwitcher } from '../features/switcher/TaskSwitcher.js'
import { SettingsScreen } from '../features/settings/SettingsScreen.js'
import { WeekScreen } from '../features/week/WeekScreen.js'
import { PhoneAgenda } from '../features/agenda/PhoneAgenda.js'
import { ReportsScreen } from '../features/reports/ReportsScreen.js'
import { StatisticsScreen } from '../features/statistics/StatisticsScreen.js'
import { MoneyScreen } from '../features/money/MoneyScreen.js'
import { useTracking } from '../hooks/useTracking.js'
import { events } from '../api/client.js'
import { playCue } from '../lib/cues.js'

/**
 * Plain state-based navigation instead of a router. Five fixed screens, no URLs, no deep
 * links — a router would be a dependency to audit for no benefit.
 */
export function App() {
  const [screen, setScreen] = useState<Screen>('today')
  const [switcherOpen, setSwitcherOpen] = useState(false)
  /** Bumped by the hotkey/tray; Today watches it and opens the wizard. */
  const [endOfDayRequest, setEndOfDayRequest] = useState(0)
  /** Same idea, for the morning notification asking you to plan the day. */
  const [planDayRequest, setPlanDayRequest] = useState(0)
  const tracking = useTracking()
  const [toast, setToast] = useState<{ id: number; message: string; leaving: boolean } | null>(null)
  /** The evening question — "anything to add to the agenda?" — opens this. */
  const [composerOpen, setComposerOpen] = useState(false)
  const [jarvisOpen, setJarvisOpen] = useState(false)
  /** Talking is the default way in; typing is one tap away from it. */
  const [voiceOpen, setVoiceOpen] = useState(false)

  useEffect(() => events.on('jarvis:open', () => setVoiceOpen(true)), [])
  // Only this window plays a reminder's sound, so the Jarvis corner does not double it.
  useEffect(() => events.on('cue:play', ({ cue }) => playCue(cue)), [])
  const compact = useCompact()

  const openSwitcher = useCallback(() => setSwitcherOpen(true), [])

  useEffect(() => {
    let leave: ReturnType<typeof setTimeout> | undefined
    let remove: ReturnType<typeof setTimeout> | undefined
    const off = events.on('notify', ({ message }) => {
      clearTimeout(leave)
      clearTimeout(remove)
      setToast({ id: Date.now(), message, leaving: false })
      // Six seconds on screen, then it sinks out; unmounted once the exit has played.
      leave = setTimeout(() => setToast((current) => (current ? { ...current, leaving: true } : null)), 6000)
      remove = setTimeout(() => setToast(null), 6450)
    })
    return () => {
      off()
      clearTimeout(leave)
      clearTimeout(remove)
    }
  }, [])

  /**
   * The main process owns the global hotkeys and the tray, but not the layout — it names
   * a destination and this decides what that means.
   */
  useEffect(() => {
    return events.on('ui:open', ({ target }) => {
      if (target === 'switcher') setSwitcherOpen(true)
      else if (target === 'endOfDay') {
        setScreen('today')
        setEndOfDayRequest(Date.now())
      } else if (target === 'planDay') {
        setScreen('today')
        setPlanDayRequest(Date.now())
      } else if (target === 'today') setScreen('today')
      else if (target === 'tasks') setScreen('tasks')
      else if (target === 'agenda') setScreen('week')
      else if (target === 'money') setScreen('money')
      else if (target === 'addEvent') {
        setScreen('week')
        setComposerOpen(true)
      }
    })
  }, [])

  /**
   * In-window shortcut for the switcher. The OS-wide version lands with the global
   * hotkeys; this already covers the case where Uurwerk is the focused window.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.altKey && event.code === 'Space') {
        event.preventDefault()
        setSwitcherOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className={`flex h-full w-full bg-bg text-text ${compact ? 'flex-col pt-[env(safe-area-inset-top)]' : ''}`}>
      {!compact && <IconRail active={screen} onNavigate={setScreen} />}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {!compact && <TopBar running={tracking.running} onJarvis={() => setVoiceOpen(true)} />}

        {/* Keyed by screen: each screen mounts fresh and its sections rise in one by one. */}
        <main key={screen} className="screen-enter min-h-0 flex-1 overflow-y-auto">
          {screen === 'today' && (
            <TodayScreen
              tracking={tracking}
              onNavigate={setScreen}
              onPickTask={openSwitcher}
              endOfDayRequest={endOfDayRequest}
              planDayRequest={planDayRequest}
            />
          )}
          {screen === 'tasks' && <TasksScreen tracking={tracking} />}
          {screen === 'projects' && <ProjectsScreen />}
          {screen === 'settings' && <SettingsScreen />}
          {/* The phone gets its own agenda in the widget's look; the desktop keeps the planner grid. */}
          {screen === 'week' && (compact ? <PhoneAgenda /> : <WeekScreen />)}
          {screen === 'reports' && <ReportsScreen />}
          {screen === 'statistics' && <StatisticsScreen />}
          {screen === 'money' && <MoneyScreen />}
        </main>
      </div>

      {compact && <BottomBar active={screen} onNavigate={setScreen} onJarvis={() => setVoiceOpen(true)} />}

      <JarvisVoice
        open={voiceOpen}
        onClose={() => setVoiceOpen(false)}
        onKeyboard={() => {
          setVoiceOpen(false)
          setJarvisOpen(true)
        }}
      />
      <JarvisSheet open={jarvisOpen} onClose={() => setJarvisOpen(false)} />

      {composerOpen && (
        <EventComposer
          initialDate={toIsoDate(Date.now())}
          onCreated={() => setComposerOpen(false)}
          onClose={() => setComposerOpen(false)}
        />
      )}

      <TaskSwitcher
        open={switcherOpen}
        tracking={tracking}
        onClose={() => setSwitcherOpen(false)}
      />

      {toast && (
        <div
          key={toast.id}
          className={`${toast.leaving ? 'toast-out' : 'animate-toast-in'} fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-[16px] border border-border bg-card px-5 py-3 text-sm font-semibold shadow-[0_20px_60px_rgba(0,0,0,0.5)]`}
        >
          {toast.message}
        </div>
      )}
    </div>
  )
}
