import { useEffect, useState } from 'react'
import type { Settings } from '@core/contract/types.js'
import { api } from '../../api/client.js'
import { Button } from '../../ui/Button.js'
import {
  SettingRow,
  SettingsCard,
  SettingsSection,
  numberField,
  problemNote,
  statusChip,
  textField
} from './SettingsSection.js'

/**
 * How the weekly report reaches your supervisor.
 *
 * Draft is the default and stays the recommendation: it needs no password, and you see the
 * message before anyone else does. SMTP exists because doing that fifty-two times gets old
 * — but it is opt-in, and the password never comes back out of the vault once stored.
 */
export function MailSettings({
  settings,
  onPatch
}: {
  settings: Settings
  onPatch: (changes: Partial<Settings>) => void
}) {
  const [password, setPassword] = useState('')
  const [stored, setStored] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  // The renderer may ask *whether* a secret exists, never what it is.
  useEffect(() => {
    void api.settings.hasSecret('smtpPassword').then(setStored)
  }, [])

  const savePassword = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      await api.settings.setSecret('smtpPassword', password)
      setStored(password.length > 0)
      setPassword('')
    } catch (error) {
      // The main process refuses to store a password when the OS cannot encrypt it, rather
      // than writing it in the clear. Say so instead of pretending it saved.
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const smtp = settings.mailMode === 'smtp'

  return (
    <SettingsSection
      title="Sending"
      description="Draft mode writes the message and opens your mail client, so nothing leaves this machine until you press send yourself. SMTP sends it directly and is the only mode that can record a week as sent."
    >
      <SettingsCard>
        <SettingRow label="How to send">
          <div className="flex gap-1 rounded-button bg-input p-1">
            {(['draft', 'smtp'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => onPatch({ mailMode: mode })}
                className={`h-9 rounded-input px-4 text-[14px] font-bold transition-colors ${
                  settings.mailMode === mode
                    ? 'bg-rail-active text-accent-soft'
                    : 'text-text-dim hover:text-text'
                }`}
              >
                {mode === 'draft' ? 'Open a draft' : 'Send directly'}
              </button>
            ))}
          </div>
        </SettingRow>

        {smtp && (
          <>
            {problem && <div className={`${problemNote} mx-4 mb-3 wide:mx-5`}>{problem}</div>}

            <SettingRow label="SMTP server" hint="smtp.gmail.com, smtp.office365.com, …">
              <input
                value={settings.smtpHost}
                onChange={(event) => onPatch({ smtpHost: event.target.value })}
                placeholder="smtp.example.com"
                className={textField}
              />
            </SettingRow>

            <SettingRow label="Port" hint="465 for implicit TLS, 587 for STARTTLS">
              <input
                type="number"
                min="1"
                max="65535"
                value={settings.smtpPort}
                onChange={(event) => onPatch({ smtpPort: Number(event.target.value) })}
                className={numberField}
              />
            </SettingRow>

            <SettingRow label="Username" hint="Usually your full e-mail address; it is also the sender">
              <input
                value={settings.smtpUser}
                onChange={(event) => onPatch({ smtpUser: event.target.value })}
                placeholder="jij@example.com"
                className={textField}
              />
            </SettingRow>

            <SettingRow
              label="Password"
              hint={
                stored
                  ? 'Stored and encrypted by Windows. Enter a new one to replace it, or save an empty field to remove it.'
                  : 'Use an app password if your provider offers one. Encrypted by Windows; never shown again.'
              }
            >
              <div className="flex flex-wrap items-center gap-2">
                {stored && <span className={`${statusChip} bg-rail-active text-accent-soft`}>configured</span>}
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={stored ? '••••••••' : 'app password'}
                  className={`${textField} w-52 font-code`}
                />
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => void savePassword()}>
                  Save
                </Button>
              </div>
            </SettingRow>
          </>
        )}
      </SettingsCard>
    </SettingsSection>
  )
}
