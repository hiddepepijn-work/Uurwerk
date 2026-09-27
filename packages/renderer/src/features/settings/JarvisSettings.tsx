import type { Settings } from '@core/contract/types.js'

import { SettingRow, SettingsSection, Toggle } from './SettingsSection.js'

/**
 * The laptop's wake word. "Hey Jarvis" is heard by three small models on this machine
 * (openWakeWord); nothing leaves it until you say it. The Jarvis hotkey works either way.
 */
export function JarvisSettings({
  settings,
  onPatch
}: {
  settings: Settings
  onPatch: (changes: Partial<Settings>) => void
}) {
  return (
    <SettingsSection
      title="Jarvis"
      description='Zeg "Hey Jarvis", of druk op de Jarvis-sneltoets, en hij komt rechtsonder in beeld. Het wekwoord wordt op deze laptop zelf herkend; er gaat niets de deur uit tot je het zegt.'
    >
      <SettingRow label="Luisteren naar “Hey Jarvis”" hint="Houdt de microfoon open; Windows toont dan het microfoon-icoontje">
        <Toggle checked={settings.jarvisWakeWord} onChange={(next) => onPatch({ jarvisWakeWord: next })} />
      </SettingRow>
    </SettingsSection>
  )
}
