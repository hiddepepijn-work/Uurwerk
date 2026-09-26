import { useState } from 'react'
import type { Settings } from '@core/contract/types.js'
import { useCompact } from '../../hooks/useCompact.js'
import { SettingRow, SettingsSection, Toggle, textField } from './SettingsSection.js'

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

  return (
    <SettingsSection
      title="Focus"
      description="Stage work always, private jobs from 30 minutes (per task adjustable). Focus starts when you start the timer on such a task and only ends when you tick it off."
    >
      {compact ? (
        <>
          <SettingRow
            label="Use the Uurwerk Focus"
            hint="Needs the one-time setup below; without it this does nothing."
          >
            <Toggle checked={settings.focusShortcuts} onChange={(next) => onPatch({ focusShortcuts: next })} />
          </SettingRow>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-[13px] leading-relaxed text-text-dim">
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
          <p className="mt-2 text-[12px] text-text-faint">
            iOS lets you turn a Focus off yourself; a hard lock needs Apple&apos;s Screen Time permission, which a free
            account cannot get.
          </p>
        </>
      ) : (
        <SettingRow
          label="Close these programs"
          hint="Process names, comma separated (as in Task Manager, without .exe). Closed every 15 seconds while a focus task runs."
        >
          <input
            value={apps}
            onChange={(event) => setApps(event.target.value)}
            onBlur={() =>
              onPatch({
                focusBlockedApps: apps
                  .split(',')
                  .map((name) => name.trim())
                  .filter(Boolean)
              })
            }
            className={textField}
          />
        </SettingRow>
      )}
    </SettingsSection>
  )
}
