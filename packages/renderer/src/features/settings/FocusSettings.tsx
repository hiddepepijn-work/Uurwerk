import { useState } from 'react'
import type { Settings } from '@core/contract/types.js'
import { useCompact } from '../../hooks/useCompact.js'
import { SettingRow, SettingsCard, SettingsSection, Toggle, selectField, textField } from './SettingsSection.js'

/**
 * Focus: while a focus task is on, the phone allows only the essentials and the laptop
 * closes distracting programs — until the task is done. Which tasks count is set per task
 * (stage always, private work from half an hour by default).
 */
export function FocusSettings({
  settings,
  onPatch
}: {
  settings: Settings
  onPatch: (changes: Partial<Settings>) => void
}) {
  const compact = useCompact()
  const [apps, setApps] = useState(settings.focusBlockedApps.join(', '))
  const [allowed, setAllowed] = useState(settings.focusAllowedApps.join(', '))
  const [sites, setSites] = useState(settings.focusBlockedSites.join(', '))
  const allowMode = settings.focusMode !== 'block'

  return (
    <SettingsSection
      title="Focus"
      description="Stage work always, private jobs from 30 minutes (per task adjustable). Focus starts when you start the timer on such a task and only ends when you tick it off."
    >
      {compact ? (
        <SettingsCard>
          <SettingRow
            label="Use the Uurwerk Focus"
            hint="Needs the one-time setup below; without it this does nothing."
          >
            <Toggle checked={settings.focusShortcuts} onChange={(next) => onPatch({ focusShortcuts: next })} />
          </SettingRow>
          <ol className="list-none space-y-3 border-t border-border px-4 pt-3 pb-3.5 text-[14px] leading-[1.45] font-medium text-text-dim [counter-reset:step] [&_b]:font-bold [&_b]:text-text [&>li]:relative [&>li]:pl-[38px] [&>li]:[counter-increment:step] [&>li]:before:absolute [&>li]:before:top-[-3px] [&>li]:before:left-0 [&>li]:before:flex [&>li]:before:h-[26px] [&>li]:before:w-[26px] [&>li]:before:items-center [&>li]:before:justify-center [&>li]:before:rounded-full [&>li]:before:bg-input [&>li]:before:text-[13px] [&>li]:before:font-bold [&>li]:before:text-accent-soft [&>li]:before:content-[counter(step)]">
            <li>
              Settings → <b>Focus</b> → <b>+</b> → <b>Custom</b>, name it <b>Uurwerk</b>. Under <b>Apps</b> choose
              "Allow": your bank, WhatsApp, Phone, Messages, Uurwerk. Under <b>People</b> whoever may reach you.
            </li>
            <li>
              In <b>Shortcuts</b>: new shortcut <b>Uurwerk Focus Aan</b> with the action <i>Set Focus</i> → Uurwerk →{' '}
              <b>On</b>, until <b>Turned Off</b>.
            </li>
            <li>
              Second shortcut <b>Uurwerk Focus Uit</b>: <i>Set Focus</i> → Uurwerk → <b>Off</b>.
            </li>
            <li>Switch the toggle above on. Starting the timer on a focus task now switches it on.</li>
          </ol>
          <p className="mx-4 mb-3.5 rounded-button bg-warn-soft px-3 py-3 text-[13px] leading-[1.45] font-semibold text-warn">
            iOS lets you turn a Focus off yourself; a hard lock needs Apple&apos;s Screen Time permission, which a free
            account cannot get.
          </p>
        </SettingsCard>
      ) : (
        <SettingsCard>
          <SettingRow
            label="On the laptop"
            hint="Allow-only closes every program with a window that is not on the list; Windows itself and Uurwerk always stay."
          >
            <select
              value={settings.focusMode}
              onChange={(event) => onPatch({ focusMode: event.target.value as Settings['focusMode'] })}
              className={selectField}
            >
              <option value="allow">Allow only these programs</option>
              <option value="block">Close these programs</option>
            </select>
          </SettingRow>
          {allowMode ? (
            <SettingRow
              label="Allow only these programs"
              hint="Process names, comma separated (as in Task Manager, without .exe). The rest is asked to close every 15 seconds while a focus task runs, and forced if it stays."
            >
              <input
                value={allowed}
                onChange={(event) => setAllowed(event.target.value)}
                onBlur={() => onPatch({ focusAllowedApps: splitList(allowed) })}
                className={textField}
              />
            </SettingRow>
          ) : (
            <SettingRow
              label="Close these programs"
              hint="Process names, comma separated (as in Task Manager, without .exe). Closed every 15 seconds while a focus task runs."
            >
              <input
                value={apps}
                onChange={(event) => setApps(event.target.value)}
                onBlur={() => onPatch({ focusBlockedApps: splitList(apps) })}
                className={textField}
              />
            </SettingRow>
          )}
          <SettingRow
            label="Block these sites in Chrome"
            hint="Needs the Uurwerk Focus extension: chrome://extensions → Developer mode → Load unpacked → packages\main\chrome-focus."
          >
            <input
              value={sites}
              onChange={(event) => setSites(event.target.value)}
              onBlur={() => onPatch({ focusBlockedSites: splitList(sites) })}
              className={textField}
            />
          </SettingRow>
        </SettingsCard>
      )}
    </SettingsSection>
  )
}

/** "steam, discord ," → ['steam', 'discord']. */
const splitList = (text: string): string[] =>
  text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
