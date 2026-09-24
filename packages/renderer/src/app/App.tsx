import { useCallback, useEffect, useState } from 'react'
import { IconRail, type Screen } from './IconRail.js'
import { TopBar } from './TopBar.js'
import { TodayScreen } from '../features/today/TodayScreen.js'
import { TasksScreen } from '../features/tasks/TasksScreen.js'
import { ProjectsScreen } from '../features/projects/ProjectsScreen.js'
import { TaskSwitcher } from '../features/switcher/TaskSwitcher.js'
import { SettingsScreen } from '../features/settings/SettingsScreen.js'
import { WeekScreen } from '../features/week/WeekScreen.js'
import { ReportsScreen } from '../features/reports/ReportsScreen.js'
import { StatisticsScreen } from '../features/statistics/StatisticsScreen.js'
import { useTracking } from '../hooks/useTracking.js'
import { events } from '../api/client.js'

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
  const [toast, setToast] = useState<string | null>(null)

  const openSwitcher = useCallback(() => setSwitcherOpen(true), [])

  useEffect(() => {
    const off = events.on('notify', ({ message }) => {
      setToast(message)
      setTimeout(() => setToast(null), 6000)
    })
    return off
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
    <div className="flex h-full w-full bg-bg text-text">
      <IconRail active={screen} onNavigate={setScreen} />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar running={tracking.running} />

        <main className="min-h-0 flex-1 overflow-y-auto">
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
          {screen === 'week' && <WeekScreen />}
          {screen === 'reports' && <ReportsScreen />}
          {screen === 'statistics' && <StatisticsScreen />}
        </main>
      </div>

      <TaskSwitcher
        open={switcherOpen}
        tracking={tracking}
        onClose={() => setSwitcherOpen(false)}
      />

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-[12px] border border-border bg-card px-5 py-3 text-sm shadow-lg">
          {toast}
        </div>
      )}
    </div>
  )
}
