import { useEffect, useState } from 'react'
import type { Settings } from '@core/contract/types.js'
import { api } from '../../api/client.js'
import { Button } from '../../ui/Button.js'
import {
  SettingRow,
  SettingsCard,
  SettingsSection,
  Toggle,
  problemNote,
  statusChip,
  textField
} from './SettingsSection.js'

/**
 * The online view for your supervisor.
 *
 * Off by default and useless until you point it at a host you control. Nothing here changes
 * what may be published — that is decided per day in the end-of-day wizard, and no setting
 * on this screen can widen it.
 */
export function PublishSettings({
  settings,
  onPatch
}: {
  settings: Settings
  onPatch: (changes: Partial<Settings>) => void
}) {
  const [token, setToken] = useState('')
  const [stored, setStored] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  /** The exact payload, as JSON. Seeing it beats being told what it contains. */
  const [preview, setPreview] = useState<string | null>(null)

  const showPreview = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      setPreview(JSON.stringify(await api.publish.preview(), null, 2))
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const publishNow = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      await api.publish.now()
      setPreview(JSON.stringify(await api.publish.preview(), null, 2))
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void api.settings.hasSecret('publishToken').then(setStored)
  }, [])

  const saveToken = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      await api.settings.setSecret('publishToken', token)
      setStored(token.length > 0)
      setToken('')
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsSection
      title="Publishing"
      description="Uploads approved days to a place your supervisor can reach. What goes up is decided per day in the end-of-day wizard; nothing here can publish anything by itself."
    >
      {problem && <div className={problemNote}>{problem}</div>}

      <SettingsCard>
        <SettingRow
          label="Allow publishing"
          hint="With this off, Publish refuses rather than uploading anything"
        >
          <Toggle
            checked={settings.publishEnabled}
            onChange={(next) => onPatch({ publishEnabled: next })}
          />
        </SettingRow>

        <SettingRow
          label="Upload endpoint"
          hint="Must be https. Files are PUT to {url}/{name} with the token as a bearer header, and DELETEd the same way."
        >
          <input
            value={settings.publishUrl}
            onChange={(event) => onPatch({ publishUrl: event.target.value })}
            placeholder="https://uurwerk.example.com/upload"
            className={textField}
          />
        </SettingRow>

        <SettingRow
          label="Token"
          hint={
            stored
              ? 'Stored and encrypted by Windows. Enter a new one to replace it, or save an empty field to remove it.'
              : 'The bearer token your endpoint expects. Encrypted by Windows; never shown again.'
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            {stored && <span className={`${statusChip} bg-rail-active text-accent-soft`}>configured</span>}
            <input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder={stored ? '••••••••' : 'bearer token'}
              className={`${textField} w-52 font-code`}
            />
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void saveToken()}>
              Save
            </Button>
          </div>
        </SettingRow>

        <SettingRow
          label="Live status"
          hint="Text and numbers only: stage hours, whether you are working now, and how the week is going. Names appear only for work whose area and project both allow it."
        >
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void showPreview()}>
              Preview
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || !settings.publishEnabled}
              onClick={() => void publishNow()}
            >
              Publish now
            </Button>
          </div>
        </SettingRow>

        {preview && (
          <pre
            data-selectable
            className="mx-4 mb-3 max-h-56 overflow-auto rounded-button bg-sidebar p-3 font-code text-[12px] leading-[1.55] font-medium text-text-dim wide:mx-5"
          >
            {preview}
          </pre>
        )}

        <p className="max-w-xl px-4 pb-3.5 text-[12px] leading-[1.45] font-medium text-text-faint wide:px-5">
          Put a login in front of whatever serves those files. Uurwerk gives every upload a
          random name so a URL cannot be guessed from a date, but an unguessable URL is not a
          lock — the login is.
        </p>
      </SettingsCard>
    </SettingsSection>
  )
}
