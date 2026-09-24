import { useState } from 'react'
import type { CalendarAccount, CalendarSource } from '@core/contract/types.js'
import { api } from '../../api/client.js'
import { useLiveQuery } from '../../hooks/useLiveQuery.js'
import { Button } from '../../ui/Button.js'
import { SettingRow, SettingsSection, Toggle, textField } from './SettingsSection.js'

/**
 * Connected calendars.
 *
 * Only subscribed links for now, and the copy says so rather than implying a two-way
 * connection that does not exist. A published calendar is read-only by nature: Uurwerk can
 * show the appointments and plan around them, and cannot move them.
 */
export function CalendarSettings() {
  const { data: accounts, refetch } = useLiveQuery(
    (client) => client.calendar.accounts(),
    ['settings'],
    []
  )
  const { data: calendars, refetch: refetchCalendars } = useLiveQuery(
    (client) => client.calendar.calendars(),
    ['settings'],
    []
  )
  const { data: areas } = useLiveQuery((client) => client.areas.list(), ['settings'], [])

  const [url, setUrl] = useState('')
  const [label, setLabel] = useState('')
  const [appleId, setAppleId] = useState('')
  const [appPassword, setAppPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const connect = async (): Promise<void> => {
    if (!url.trim()) return
    setBusy(true)
    setProblem(null)
    setNotice(null)
    try {
      const result = await api.calendar.connectIcs(url.trim(), label.trim() || undefined)
      setUrl('')
      setLabel('')
      setNotice(
        `${result.accountName}: ${result.imported} event${result.imported === 1 ? '' : 's'} imported` +
          (result.autoClassified > 0 ? `, ${result.autoClassified} classified automatically` : '') +
          (result.pending > 0 ? `, ${result.pending} waiting to be classified` : '')
      )
      refetch()
      refetchCalendars()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const connectIcloud = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    setNotice(null)
    try {
      const result = await api.calendar.connectIcloud(appleId.trim(), appPassword.trim())
      // Cleared straight away: there is no reason for a credential to sit in a form field
      // after it has been handed to the vault.
      setAppPassword('')
      setNotice(
        `${result.accountName} connected: ${result.imported} event${result.imported === 1 ? '' : 's'} imported` +
          (result.pending > 0 ? `, ${result.pending} waiting to be classified` : '')
      )
      refetch()
      refetchCalendars()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const syncNow = async (accountId?: string): Promise<void> => {
    setBusy(true)
    setProblem(null)
    setNotice(null)
    try {
      const results = await api.calendar.syncNow(accountId)
      const failed = results.filter((result) => result.error !== null)
      if (failed.length > 0) setProblem(failed.map((r) => `${r.accountName}: ${r.error}`).join(' · '))

      const ok = results.filter((result) => result.error === null)
      if (ok.length > 0) {
        const imported = ok.reduce((sum, result) => sum + result.imported, 0)
        const updated = ok.reduce((sum, result) => sum + result.updated, 0)
        const pending = ok.reduce((sum, result) => sum + result.pending, 0)
        setNotice(
          `${imported} new, ${updated} updated` +
            (pending > 0 ? `, ${pending} waiting to be classified` : '')
        )
      }
      refetch()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async (account: CalendarAccount): Promise<void> => {
    setBusy(true)
    try {
      await api.calendar.disconnect(account.id)
      refetch()
      refetchCalendars()
    } finally {
      setBusy(false)
    }
  }

  const updateCalendar = async (id: string, patch: Partial<CalendarSource>): Promise<void> => {
    await api.calendar.updateCalendar(id, patch)
    refetchCalendars()
  }

  return (
    <SettingsSection
      title="Calendar integrations"
      description="Subscribe to a published calendar and its appointments appear in your week and block your planning. Read-only: Uurwerk shows and plans around these events, it does not change them."
      action={
        (accounts ?? []).length > 0 && (
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void syncNow()}>
            Sync now
          </Button>
        )
      }
    >
      {problem && (
        <div className="mb-4 rounded-[10px] border border-prio-med/40 bg-prio-med/10 px-4 py-3 text-[13px] text-prio-med">
          {problem}
        </div>
      )}
      {notice && (
        <div className="mb-4 rounded-[10px] border border-accent/30 bg-accent/5 px-4 py-3 text-[13px] text-text">
          {notice}
        </div>
      )}

      {(accounts ?? []).map((account) => {
        const own = (calendars ?? []).filter((calendar) => calendar.accountId === account.id)

        return (
          <div key={account.id} className="mb-4 rounded-[12px] border border-border bg-bg p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[14px] text-text">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      account.status === 'connected' ? 'bg-accent' : 'bg-prio-med'
                    }`}
                  />
                  {account.displayName}
                </div>
                <div className="mt-1 text-[12px] text-text-dim">
                  Subscribed link{account.accountIdentifier ? ` · ${account.accountIdentifier}` : ''}
                  {account.lastSyncAt
                    ? ` · last synced ${new Date(account.lastSyncAt).toLocaleString('en-GB')}`
                    : ' · never synced'}
                </div>
                {account.lastError && (
                  <div className="mt-1 text-[12px] text-prio-med">{account.lastError}</div>
                )}
              </div>

              <div className="flex shrink-0 gap-2">
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void syncNow(account.id)}>
                  Sync
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void disconnect(account)}>
                  Disconnect
                </Button>
              </div>
            </div>

            {own.map((calendar) => (
              <div key={calendar.id} className="mt-3 border-t border-border pt-3">
                <SettingRow
                  label={calendar.name}
                  hint="A default area means events from this calendar arrive classified instead of asking"
                >
                  <div className="flex items-center gap-3">
                    <select
                      value={calendar.defaultAreaId ?? ''}
                      onChange={(event) =>
                        void updateCalendar(calendar.id, {
                          defaultAreaId: event.target.value || null
                        })
                      }
                      className="rounded-[8px] border border-border bg-bg px-2.5 py-1.5 text-[13px] text-text-dim outline-none focus:border-accent"
                    >
                      <option value="">No default area</option>
                      {(areas ?? []).map((area) => (
                        <option key={area.id} value={area.id}>
                          {area.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </SettingRow>

                <SettingRow
                  label="Block my planning"
                  hint="Turn off for calendars like birthdays: visible, but they do not own the hour"
                >
                  <Toggle
                    checked={!calendar.ignoreForPlanning}
                    onChange={(next) =>
                      void updateCalendar(calendar.id, { ignoreForPlanning: !next })
                    }
                  />
                </SettingRow>
              </div>
            ))}
          </div>
        )
      })}

      {/* iCloud is the only connection that can be written to, so it gets its own card
          rather than hiding behind the subscribe box that cannot. */}
      <div className="mb-4 rounded-[12px] border border-accent/30 bg-accent/5 p-4">
        <h3 className="mb-1 text-[14px] font-semibold">Connect iCloud</h3>
        <p className="mb-3 max-w-xl text-[12px] leading-relaxed text-text-dim">
          The only connection that works in both directions. Uurwerk reads your calendars and
          writes your plan to a separate <strong className="text-text">Uurwerk</strong> calendar
          it creates — your own calendars are never written to.
        </p>
        <p className="mb-3 max-w-xl text-[12px] leading-relaxed text-text-dim">
          You need an <strong className="text-text">app-specific password</strong>, not your
          Apple ID password. On your iPhone: Settings → your name → Sign-In &amp; Security →
          App-Specific Passwords. It looks like <span className="font-mono">abcd-efgh-ijkl-mnop</span>.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <input
            value={appleId}
            onChange={(event) => setAppleId(event.target.value)}
            placeholder="Apple ID (e-mail)"
            autoComplete="off"
            className="min-w-[220px] flex-1 rounded-[8px] border border-border bg-card px-3 py-2 text-[13px] text-text outline-none placeholder:text-text-faint focus:border-accent"
          />
          <input
            value={appPassword}
            onChange={(event) => setAppPassword(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && void connectIcloud()}
            placeholder="abcd-efgh-ijkl-mnop"
            // Masked like any other credential: this is a real key to your iCloud data.
            type="password"
            autoComplete="off"
            className="min-w-[200px] flex-1 rounded-[8px] border border-border bg-card px-3 py-2 font-mono text-[13px] text-text outline-none placeholder:text-text-faint focus:border-accent"
          />
          <Button
            variant="primary"
            size="sm"
            disabled={busy || !appleId.trim() || !appPassword.trim()}
            onClick={() => void connectIcloud()}
          >
            Connect
          </Button>
        </div>

        <p className="mt-3 text-[12px] text-text-faint">
          The password is encrypted with Windows DPAPI and never written to the database. Revoke
          it any time from the same Apple screen — it grants access to iCloud data only, and
          cannot change your account.
        </p>
      </div>

      <div className="rounded-[12px] border border-border bg-bg p-4">
        <h3 className="mb-1 text-[14px] font-semibold">Subscribe to a calendar</h3>
        <p className="mb-3 max-w-xl text-[12px] leading-relaxed text-text-dim">
          In Outlook on the web: Settings → Calendar → Shared calendars → Publish a calendar,
          choose <strong className="text-text">Can view all details</strong>, and copy the{' '}
          <strong className="text-text">ICS</strong> link. Anything that publishes an .ics works —
          iCloud, Google, a school timetable.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && void connect()}
            placeholder="https://outlook.office365.com/owa/calendar/…/calendar.ics"
            className="min-w-[280px] flex-1 rounded-[8px] border border-border bg-card px-3 py-2 text-[13px] text-text outline-none placeholder:text-text-faint focus:border-accent"
          />
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Name (optional)"
            className={textField}
          />
          <Button variant="primary" size="sm" disabled={busy || !url.trim()} onClick={() => void connect()}>
            Subscribe
          </Button>
        </div>

        <p className="mt-3 text-[12px] text-text-faint">
          The publisher decides how fresh this is — Microsoft regenerates a published calendar on
          its own schedule, sometimes hours behind. The link is stored encrypted, like your other
          credentials.
        </p>
      </div>
    </SettingsSection>
  )
}
