import { useEffect, useState } from 'react'

import type { JarvisLiveSpend } from '@core/contract/api.js'
import type { Settings } from '@core/contract/types.js'

import { api } from '../../api/client.js'
import { SettingRow, SettingsCard, SettingsSection, Toggle, selectField } from './SettingsSection.js'

/**
 * Jarvis: the laptop's wake word, and what he costs. "Hey Jarvis" is heard by three small
 * models on this machine (openWakeWord); nothing leaves it until you say it. The cost is
 * the server's own count from the tokens the models report — Google's bill is the truth,
 * this is close to it.
 */
export function JarvisSettings({
  settings,
  onPatch
}: {
  settings: Settings
  onPatch: (changes: Partial<Settings>) => void
}) {
  const [spend, setSpend] = useState<JarvisLiveSpend | null>(null)

  useEffect(() => {
    void api.jarvis
      .status()
      .then((status) => setSpend(status.spend ?? null))
      .catch(() => setSpend(null))
  }, [])

  const euro = (usd: number): string => `$${usd.toFixed(2)}`
  const share = spend ? Math.min(100, (spend.usd / spend.capUsd) * 100) : 0

  return (
    <SettingsSection
      title="Jarvis"
      description='Zeg "Hey Jarvis", of druk op de Jarvis-sneltoets, en hij komt rechtsonder in beeld. Het wekwoord wordt op deze laptop zelf herkend; er gaat niets de deur uit tot je het zegt.'
    >
      <SettingsCard>
        <SettingRow label="Luisteren naar “Hey Jarvis”" hint="Houdt de microfoon open; Windows toont dan het microfoon-icoontje">
          <Toggle checked={settings.jarvisWakeWord} onChange={(next) => onPatch({ jarvisWakeWord: next })} />
        </SettingRow>
        <SettingRow label="Stem-model" hint="Eigen lijn: Gemini Flash denkt, Maarten praat; ruim onder €10 per maand. Lukt die niet, dan neemt Gemini Live het over.">
          <select
            value={settings.jarvisVoiceModel}
            onChange={(event) => onPatch({ jarvisVoiceModel: event.target.value as Settings['jarvisVoiceModel'] })}
            className={selectField}
          >
            <option value="cascade">Eigen lijn · Flash + Maarten (goedkoopst)</option>
            <option value="openai">OpenAI realtime mini</option>
            <option value="gemini">Gemini Live · slimmer</option>
          </select>
        </SettingRow>
        <SettingRow
          label="Verbruik deze maand"
          hint="Geschat uit wat de modellen melden. De echte rekeningen staan op platform.openai.com/usage en aistudio.google.com/spend."
        >
          {spend ? (
            <div className="flex w-[240px] max-w-full flex-col gap-2">
              <div className="flex items-baseline justify-between gap-3 text-[15px]">
                <span className="font-bold text-text tabular-nums">
                  {euro(spend.usd)} <span className="font-medium text-text-dim">van {euro(spend.capUsd)}</span>
                </span>
                <span className="text-[13px] font-medium text-text-faint tabular-nums">
                  praten {euro(spend.live)} · typen {euro(spend.text)}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-border">
                <div
                  className={`h-full rounded-full ${share > 80 ? 'bg-warn' : 'bg-accent'}`}
                  style={{ width: `${share}%` }}
                />
              </div>
            </div>
          ) : (
            <span className="text-[13px] font-medium text-text-dim">Niet bereikbaar (server)</span>
          )}
        </SettingRow>
      </SettingsCard>
    </SettingsSection>
  )
}
