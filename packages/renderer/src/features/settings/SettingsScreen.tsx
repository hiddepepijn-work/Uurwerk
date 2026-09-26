import { useEffect, useState } from 'react'
import type { Hotkeys, Settings } from '@core/contract/types.js'
import { SYSTEM_AREAS } from '@core/contract/types.js'
import type { LoginItemStatus } from '@core/contract/api.js'
import { api } from '../../api/client.js'
import { useLiveQuery } from '../../hooks/useLiveQuery.js'
import { Button } from '../../ui/Button.js'
import { CalendarSettings } from './CalendarSettings.js'
import { CaptureSettings } from './CaptureSettings.js'
import { MailSettings } from './MailSettings.js'
import { OrganizationSettings } from './OrganizationSettings.js'
import { ProjectSettings } from './ProjectSettings.js'
import { PublishSettings } from './PublishSettings.js'
import { ServerSettings } from './ServerSettings.js'
import { FocusSettings } from './FocusSettings.js'
import { SettingRow, SettingsSection, Toggle, numberField, textField } from './SettingsSection.js'

/** The three built-in areas; they cannot be archived, so they get no archive button. */
const SYSTEM_AREA_IDS: string[] = Object.values(SYSTEM_AREAS)

const HOTKEY_LABELS: Array<{ key: keyof Hotkeys; label: string; hint: string }> = [
  { key: 'startStop', label: 'Start / stop tracking', hint: 'Stops straight away; starting opens the task picker' },
  { key: 'quickAdd', label: 'Quick add task', hint: 'A one-line window, without leaving what you are doing' },
  { key: 'toggleWindow', label: 'Show / hide Uurwerk', hint: '' },
  {
    key: 'markScreenshot',
    label: 'Take a screenshot now',
    hint: 'Captures the screen and marks the frame for the report straight away'
  },
  { key: 'endOfDay', label: 'End of day', hint: '' }
]

/**
 * Everything the app can be told, in one place.
 *
 * Ordered by how often you will touch it: projects and areas first, then the hotkeys you
 * use daily, then the things you set once.
 */
export function SettingsScreen() {
  const { data: settings, refetch } = useLiveQuery((client) => client.settings.get(), ['settings'])
  /** Quitting mid-timer is safe — the run is closed and saved — but it should still say so. */
  const { data: currentSegment } = useLiveQuery(
    (client) => client.tracking.currentSegment(),
    ['sessions'],
    []
  )
  const running = currentSegment !== null && currentSegment !== undefined
  const [confirmingQuit, setConfirmingQuit] = useState(false)
  const { data: projects, refetch: refetchProjects } = useLiveQuery(
    (client) => client.projects.list(),
    ['settings'],
    []
  )
  const { data: areas, refetch: refetchAreas } = useLiveQuery(
    (client) => client.areas.list(),
    ['settings'],
    []
  )
  const { data: organizations, refetch: refetchOrganizations } = useLiveQuery(
    (client) => client.organizations.list(),
    ['settings'],
    []
  )
  const { data: workTypes, refetch: refetchWorkTypes } = useLiveQuery(
    (client) => client.workTypes.list(),
    ['settings'],
    []
  )

  const [loginItem, setLoginItem] = useState<LoginItemStatus | null>(null)
  const [recording, setRecording] = useState<keyof Hotkeys | null>(null)
  const [newArea, setNewArea] = useState('')

  const addArea = async (): Promise<void> => {
    const name = newArea.trim()
    if (!name) return
    // Defaults are the private ones; widening is a decision made with the checkboxes above.
    await api.areas.create({ name, countsAsStageHours: false, defaultShareSupervisor: false })
    setNewArea('')
    refetchAreas()
  }

  useEffect(() => {
    void api.startup.getLoginItemStatus().then(setLoginItem)
  }, [])

  const patch = async (changes: Partial<Settings>): Promise<void> => {
    await api.settings.update(changes)
    refetch()
  }

  /** Captures the next key combination and stores it as an Electron accelerator. */
  useEffect(() => {
    if (!recording || !settings) return

    const onKey = (event: KeyboardEvent): void => {
      event.preventDefault()
      if (event.key === 'Escape') {
        setRecording(null)
        return
      }
      // Modifiers alone are not a shortcut; wait for the real key.
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return

      const parts: string[] = []
      if (event.ctrlKey || event.metaKey) parts.push('CommandOrControl')
      if (event.altKey) parts.push('Alt')
      if (event.shiftKey) parts.push('Shift')
      parts.push(event.code === 'Space' ? 'Space' : event.key.toUpperCase())

      void patch({ hotkeys: { ...settings.hotkeys, [recording]: parts.join('+') } })
      setRecording(null)
    }

    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, settings])

  if (!settings) return null

  const pretty = (accelerator: string): string => accelerator.replace('CommandOrControl', 'Ctrl')

  return (
    <div className="mx-auto max-w-3xl p-4 wide:p-8">
      <header className="mb-8">
        <h1 className="text-[32px] leading-tight font-semibold">Settings</h1>
      </header>

      <ProjectSettings
        projects={projects ?? []}
        areas={areas ?? []}
        organizations={organizations ?? []}
        onChanged={() => {
          refetchProjects()
          refetchAreas()
        }}
      />

      <OrganizationSettings
        organizations={organizations ?? []}
        workTypes={workTypes ?? []}
        onChanged={() => {
          refetchOrganizations()
          refetchWorkTypes()
          refetchProjects()
        }}
      />

      <SettingsSection
        title="Areas"
        description="The category above projects. An area decides whether its hours count toward your internship and whether they may ever leave this machine — a project can narrow that, never widen it."
      >
        <div className="overflow-hidden rounded-[12px] border border-border">
          {(areas ?? []).map((area) => (
            <div
              key={area.id}
              className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-b-0"
            >
              <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: area.color }} />
              <span className="min-w-0 flex-1 truncate text-[14px] text-text">{area.name}</span>

              <label className="flex items-center gap-2 text-[13px] text-text-dim">
                <input
                  type="checkbox"
                  checked={area.countsAsStageHours}
                  onChange={(event) =>
                    void api.areas
                      .update(area.id, { countsAsStageHours: event.target.checked })
                      .then(refetchAreas)
                  }
                  className="accent-accent"
                />
                Counts as stage hours
              </label>

              <label className="flex items-center gap-2 text-[13px] text-text-dim">
                <input
                  type="checkbox"
                  checked={area.defaultShareSupervisor}
                  onChange={(event) =>
                    void api.areas
                      .update(area.id, { defaultShareSupervisor: event.target.checked })
                      .then(refetchAreas)
                  }
                  className="accent-accent"
                />
                Share with supervisor
              </label>

              {/* Stage, Work and Personal are refused by the repository — too much history
                  hangs off their ids — so the button is not offered for them either. */}
              {!SYSTEM_AREA_IDS.includes(area.id) && (
                <button
                  onClick={() => void api.areas.archive(area.id).then(refetchAreas)}
                  title="Archive this area"
                  className="shrink-0 rounded-md p-1.5 text-text-faint transition-colors hover:bg-card hover:text-prio-high"
                >
                  ✕
                </button>
              )}
            </div>
          ))}

          <div className="flex items-center gap-3 border-t border-border bg-bg px-4 py-3">
            <input
              value={newArea}
              onChange={(event) => setNewArea(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && void addArea()}
              placeholder="Add an area, e.g. Study"
              className="min-w-0 flex-1 rounded-[8px] border border-border bg-card px-3 py-2 text-[13px] text-text outline-none placeholder:text-text-faint focus:border-accent"
            />
            {/* Created private and not counting toward internship hours: a new area earns
                those, it does not start with them. */}
            <span className="text-[12px] text-text-faint">private until you say otherwise</span>
            <button
              onClick={() => void addArea()}
              disabled={!newArea.trim()}
              className="shrink-0 rounded-[8px] border border-border px-3 py-2 text-[13px] text-text-dim transition-colors hover:text-text disabled:opacity-40"
            >
              Add
            </button>
          </div>
        </div>

        <SettingRow
          label="Default area for new tasks"
          hint="Used by quick add and the task switcher, which have no area field"
        >
          <select
            value={settings.defaultAreaId}
            onChange={(event) => void patch({ defaultAreaId: event.target.value })}
            className="rounded-[8px] border border-border bg-bg px-3 py-2 text-[14px] text-text outline-none focus:border-accent"
          >
            {(areas ?? []).map((area) => (
              <option key={area.id} value={area.id}>
                {area.name}
              </option>
            ))}
          </select>
        </SettingRow>
      </SettingsSection>

      <SettingsSection
        title="Hotkeys"
        description="These work anywhere in Windows, not only when Uurwerk is in front. Click a shortcut and press the combination you want; Escape cancels."
      >
        {HOTKEY_LABELS.map(({ key, label, hint }) => (
          <SettingRow key={key} label={label} hint={hint}>
            <button
              onClick={() => setRecording(key)}
              className={`min-w-[150px] rounded-[8px] border px-3 py-2 font-mono text-[13px] transition-colors ${
                recording === key
                  ? 'border-accent bg-rail-active text-accent'
                  : 'border-border bg-bg text-text-dim hover:text-text'
              }`}
            >
              {recording === key ? 'Press keys…' : pretty(settings.hotkeys[key])}
            </button>
          </SettingRow>
        ))}
        <SettingRow label="Switch task" hint="Fixed for now">
          <span className="inline-block min-w-[150px] rounded-[8px] border border-border bg-bg px-3 py-2 text-center font-mono text-[13px] text-text-faint">
            Ctrl+Alt+Space
          </span>
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Goals" description="What the progress bars on Today measure against.">
        <SettingRow label="Daily goal (hours)">
          <input
            type="number"
            min="0"
            step="0.5"
            value={settings.dailyGoalMin / 60}
            onChange={(event) => void patch({ dailyGoalMin: Number(event.target.value) * 60 })}
            className={numberField}
          />
        </SettingRow>
        <SettingRow label="Weekly goal (hours)">
          <input
            type="number"
            min="0"
            step="1"
            value={settings.weeklyGoalMin / 60}
            onChange={(event) => void patch({ weeklyGoalMin: Number(event.target.value) * 60 })}
            className={numberField}
          />
        </SettingRow>
        <SettingRow
          label="Stop tracking after idle (minutes)"
          hint="Backdated to the moment you stopped touching the keyboard, so idle time is never counted. Reading or watching something also counts as idle — raise this if that catches you out."
        >
          <input
            type="number"
            min="1"
            value={settings.idleTimeoutMin}
            onChange={(event) => void patch({ idleTimeoutMin: Number(event.target.value) })}
            className={numberField}
          />
        </SettingRow>
        <SettingRow
          label="Pick the task back up when I return"
          hint="After an idle pause, tracking starts again on the same task as soon as you touch the keyboard — counting from that moment, never from when you left. Stopping the timer yourself is always final."
        >
          <Toggle
            checked={settings.resumeAfterIdle}
            onChange={(next) => void patch({ resumeAfterIdle: next })}
          />
        </SettingRow>
      </SettingsSection>

      <CaptureSettings settings={settings} onPatch={(changes) => void patch(changes)} />

      <SettingsSection
        title="Startup and window"
        description="Uurwerk lives in the tray. Starting with Windows never begins tracking and never publishes anything."
      >
        <SettingRow
          label="Start Uurwerk when I sign in to Windows"
          hint={loginItem?.supported === false ? (loginItem.reason ?? undefined) : undefined}
        >
          <Toggle
            checked={settings.autoLaunch}
            disabled={loginItem?.supported === false}
            onChange={(next) => void api.startup.setAutoLaunch(next).then(setLoginItem).then(refetch)}
          />
        </SettingRow>
        <SettingRow
          label="Keep running in the tray when I close the window"
          hint="Turn this off and closing the window quits the app, hotkeys included"
        >
          <Toggle
            checked={settings.closeToTray}
            onChange={(next) => void patch({ closeToTray: next })}
          />
        </SettingRow>

        {/* The way out. With close-to-tray on, the window's close button only hides it, so
            without this the only real exit was the tray's own menu. */}
        <SettingRow
          label="Quit Uurwerk"
          hint={
            running
              ? 'A timer is running. It will be stopped and the time saved before the app closes.'
              : 'Closes the app completely — tray icon and global hotkeys included.'
          }
        >
          {confirmingQuit ? (
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirmingQuit(false)}>
                Cancel
              </Button>
              <Button variant="danger" size="sm" onClick={() => void api.window.quit()}>
                {running ? 'Stop timer and quit' : 'Quit now'}
              </Button>
            </div>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => setConfirmingQuit(true)}>
              Quit
            </Button>
          )}
        </SettingRow>
      </SettingsSection>

      <SettingsSection
        title="Reports"
        description="Where the Dutch weekly report is written, and who it is addressed to."
      >
        <SettingRow label="Supervisor e-mail">
          <input
            type="email"
            value={settings.supervisorEmail}
            onChange={(event) => void patch({ supervisorEmail: event.target.value })}
            placeholder="begeleider@example.com"
            className={textField}
          />
        </SettingRow>
        <SettingRow label="Supervisor name" hint="Used for the greeting; blank keeps it neutral">
          <input
            value={settings.supervisorName}
            onChange={(event) => void patch({ supervisorName: event.target.value })}
            placeholder="Margriet"
            className={textField}
          />
        </SettingRow>
        <SettingRow label="Report folder" hint="Blank uses Documents\Uurwerk-rapporten">
          <input
            value={settings.reportOutputDir}
            onChange={(event) => void patch({ reportOutputDir: event.target.value })}
            placeholder="Documents\Uurwerk-rapporten"
            className={textField}
          />
        </SettingRow>
      </SettingsSection>

      <CalendarSettings />

      <MailSettings settings={settings} onPatch={(changes) => void patch(changes)} />

      <ServerSettings />

      <FocusSettings settings={settings} onPatch={(changes) => void patch(changes)} />

      <PublishSettings settings={settings} onPatch={(changes) => void patch(changes)} />
    </div>
  )
}
