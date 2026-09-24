import { useEffect, useState } from 'react'
import type { Settings } from '@core/contract/types.js'
import { api } from '../../api/client.js'
import { Button } from '../../ui/Button.js'
import { SettingRow, SettingsSection, numberField, textField } from './SettingsSection.js'

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
      <SettingRow label="How to send">
        <div className="flex rounded-[10px] border border-border bg-card p-1">
          {(['draft', 'smtp'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => onPatch({ mailMode: mode })}
              className={`rounded-[7px] px-4 py-1.5 text-[13px] transition-colors ${
                settings.mailMode === mode
                  ? 'bg-rail-active text-accent'
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
          {problem && (
            <div className="my-3 rounded-[10px] border border-prio-med/40 bg-prio-med/10 px-4 py-3 text-[13px] text-prio-med">
              {problem}
            </div>
          )}

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
            <div className="flex items-center gap-2">
              {stored && (
                <span className="rounded-full border border-accent/30 bg-accent/10 px-2.5 py-1 text-[11px] text-accent">
                  configured
                </span>
              )}
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={stored ? '••••••••' : 'app password'}
                className="w-52 rounded-[8px] border border-border bg-bg px-3 py-2 text-[14px] text-text outline-none placeholder:text-text-faint focus:border-accent"
              />
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => void savePassword()}>
                Save
              </Button>
            </div>
          </SettingRow>
        </>
      )}
    </SettingsSection>
  )
}
