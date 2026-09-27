import { useEffect, useState } from 'react'

import { api } from '../../api/client.js'
import { Button } from '../../ui/Button.js'
import { SettingRow, SettingsSection, textField } from './SettingsSection.js'

/**
 * The laptop's wake word. Porcupine hears "Jarvis" on this machine itself; the AccessKey
 * only lets it run. Free for personal use at console.picovoice.ai. Without a key, the
 * Jarvis hotkey still calls him.
 */
export function JarvisSettings() {
  const [key, setKey] = useState('')
  const [stored, setStored] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    void api.settings.hasSecret('picovoiceKey').then(setStored)
  }, [])

  const save = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      await api.settings.setSecret('picovoiceKey', key.trim())
      setStored(key.trim().length > 0)
      setKey('')
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsSection
      title="Jarvis"
      description='Zeg "Jarvis", of druk op de Jarvis-sneltoets, en hij komt rechtsonder in beeld. Het wekwoord draait op deze laptop zelf; er gaat niets de deur uit tot je zijn naam zegt.'
    >
      {problem && (
        <div className="my-3 rounded-[10px] border border-prio-med/40 bg-prio-med/10 px-4 py-3 text-[13px] text-prio-med">
          {problem}
        </div>
      )}
      <SettingRow
        label="Wekwoord-sleutel"
        hint={stored ? 'Ingesteld. Een nieuwe vervangt hem; leeg opslaan zet het wekwoord uit.' : 'Picovoice AccessKey, gratis op console.picovoice.ai'}
      >
        <div className="flex gap-2">
          <input
            type="password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder={stored ? '••••••••' : 'AccessKey'}
            className={textField}
          />
          <Button onClick={() => void save()} disabled={busy}>
            Opslaan
          </Button>
        </div>
      </SettingRow>
    </SettingsSection>
  )
}
