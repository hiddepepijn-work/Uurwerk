import { useEffect, useState } from 'react'

import type { JarvisLiveSpend } from '@core/contract/api.js'
import type { Settings } from '@core/contract/types.js'

import { api } from '../../api/client.js'
import { SettingRow, SettingsSection, Toggle } from './SettingsSection.js'

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
      <SettingRow label="Luisteren naar “Hey Jarvis”" hint="Houdt de microfoon open; Windows toont dan het microfoon-icoontje">
        <Toggle checked={settings.jarvisWakeWord} onChange={(next) => onPatch({ jarvisWakeWord: next })} />
      </SettingRow>
      <SettingRow label="Stem-model" hint="OpenAI mini kost ongeveer een kwart; Gemini is iets slimmer. Lukt OpenAI niet, dan neemt Gemini het over.">
        <select
          value={settings.jarvisVoiceModel}
          onChange={(event) => onPatch({ jarvisVoiceModel: event.target.value as Settings['jarvisVoiceModel'] })}
          className="rounded-[8px] border border-border bg-bg px-3 py-2 text-[14px] text-text outline-none focus:border-accent"
        >
          <option value="openai">OpenAI realtime mini · goedkoop</option>
          <option value="gemini">Gemini Live · slimmer</option>
        </select>
      </SettingRow>
      <SettingRow
        label="Verbruik deze maand"
        hint="Geschat uit wat de modellen melden. De echte rekeningen staan op platform.openai.com/usage en aistudio.google.com/spend."
      >
        {spend ? (
          <div className="flex min-w-[220px] flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3 text-[14px]">
              <span className="font-semibold text-text tabular-nums">
                {euro(spend.usd)} <span className="font-normal text-text-dim">van {euro(spend.capUsd)}</span>
              </span>
              <span className="text-[12px] text-text-dim tabular-nums">
                praten {euro(spend.live)} · typen {euro(spend.text)}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-bg">
              <div
                className={`h-full rounded-full ${share > 80 ? 'bg-prio-med' : 'bg-accent'}`}
                style={{ width: `${share}%` }}
              />
            </div>
          </div>
        ) : (
          <span className="text-[13px] text-text-dim">Niet bereikbaar (server)</span>
        )}
      </SettingRow>
    </SettingsSection>
  )
}
