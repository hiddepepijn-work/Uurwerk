import { useCallback, useEffect, useState } from 'react'
import type { SyncStatus } from '@core/contract/api.js'
import { api } from '../../api/client.js'
import { useCompact } from '../../hooks/useCompact.js'
import { Button } from '../../ui/Button.js'
import { SettingRow, SettingsSection, textField } from './SettingsSection.js'

/**
 * This copy and the VPS.
 *
 * The app keeps working on its own copy whether or not a server is set; pairing only adds
 * a second copy that the laptop keeps in step with, and that the phone and Jarvis will use.
 */
export function ServerSettings() {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [url, setUrl] = useState('https://uurwerk.duckdns.org')
  const [token, setToken] = useState('')
  // A phone always joins an existing server; the laptop is the one that uploads first.
  const compact = useCompact()
  const [mode, setMode] = useState<'upload' | 'download'>(compact ? 'download' : 'upload')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const refresh = useCallback(async () => setStatus(await api.sync.status()), [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 5_000)
    return () => clearInterval(timer)
  }, [refresh])

  const run = async (action: () => Promise<SyncStatus>): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      setStatus(await action())
      setToken('')
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const since = status?.lastSyncAt
    ? new Date(status.lastSyncAt).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })
    : null

  return (
    <SettingsSection
      title="Server"
      description="Keeps this laptop in step with your VPS. Everything keeps working offline; changes wait here and go up as soon as the server can be reached."
    >
      {problem && (
        <div className="mb-3 rounded-[10px] border border-prio-med/40 bg-prio-med/10 px-4 py-3 text-[13px] text-prio-med">
          {problem}
        </div>
      )}

      {status?.paired ? (
        <>
          <SettingRow label="Server" hint={`This device is "${status.deviceId ?? '?'}".`}>
            <span className="text-[14px] text-text">{status.serverUrl}</span>
          </SettingRow>
          <SettingRow
            label="State"
            hint={status.lastError && !status.online ? status.lastError : 'Rounds run every 30 seconds and shortly after each change.'}
          >
            <div className="flex items-center gap-2">
              <span
                className={`rounded-full border px-2.5 py-1 text-[11px] ${
                  status.online
                    ? 'border-accent/30 bg-accent/10 text-accent'
                    : 'border-prio-med/30 bg-prio-med/10 text-prio-med'
                }`}
              >
                {status.online ? 'online' : 'offline'}
              </span>
              <span className="text-[13px] text-text-dim">
                {status.pending > 0 ? `${status.pending} waiting` : 'all sent'}
                {since ? ` · last round ${since}` : ''}
              </span>
            </div>
          </SettingRow>
          <SettingRow label="" hint="Unlinking keeps this copy as it is; it just stops syncing.">
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => void run(() => api.sync.now())}>
                Sync now
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(() => api.sync.unpair())}>
                Unlink
              </Button>
            </div>
          </SettingRow>
        </>
      ) : (
        <>
          <SettingRow label="Server address" hint="https only; plain http is accepted for localhost.">
            <input value={url} onChange={(event) => setUrl(event.target.value)} className={textField} />
          </SettingRow>
          <SettingRow
            label="Device token"
            hint="Made on the server with: uurwerk-devices add laptop. Stored encrypted by Windows."
          >
            <input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="uw_…"
              className={textField}
            />
          </SettingRow>
          <SettingRow
            label="First time"
            hint={
              mode === 'upload'
                ? 'Send this copy to an empty server. Use this once, from the laptop that has your history.'
                : 'Replace this copy with the server’s. The current file is kept beside it; the app restarts.'
            }
          >
            <div className="flex items-center gap-2">
              <select
                value={mode}
                onChange={(event) => setMode(event.target.value as 'upload' | 'download')}
                className={textField}
              >
                <option value="upload">Upload this copy</option>
                <option value="download">Download the server’s copy</option>
              </select>
              <Button
                variant="primary"
                size="sm"
                disabled={busy || !token.trim() || !url.trim()}
                onClick={() => void run(() => api.sync.pair(url, token.trim(), mode))}
              >
                {busy ? 'Linking…' : 'Link'}
              </Button>
            </div>
          </SettingRow>
        </>
      )}
    </SettingsSection>
  )
}
