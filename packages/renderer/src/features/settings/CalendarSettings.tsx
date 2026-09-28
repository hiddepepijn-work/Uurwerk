import { useState } from 'react'
import type { CalendarAccount, CalendarSource } from '@core/contract/types.js'
import { api } from '../../api/client.js'
import { useLiveQuery } from '../../hooks/useLiveQuery.js'
import { Button } from '../../ui/Button.js'
import {
  SettingRow,
  SettingsCard,
  SettingsSection,
  Toggle,
  problemNote,
  rowSelect,
  successNote,
  textField
} from './SettingsSection.js'

/** An input that grows to share a wrapping line with its neighbours. */
const inputField = `${textField} h-11 w-auto min-w-0 flex-1`

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
      {problem && <div className={problemNote}>{problem}</div>}
      {notice && <div className={successNote}>{notice}</div>}

      {(accounts ?? []).map((account) => {
        const own = (calendars ?? []).filter((calendar) => calendar.accountId === account.id)

        return (
          <SettingsCard key={account.id}>
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2.5 px-4 py-3.5 wide:px-5">
              <div className="flex min-w-0 flex-1 basis-[220px] items-start gap-2.5">
                <span
                  className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${
                    account.status === 'connected' ? 'bg-accent' : 'bg-warn'
                  }`}
                />
                <div className="min-w-0">
                  <div className="text-[16px] font-bold text-text">{account.displayName}</div>
                  <div className="mt-0.5 text-[13px] font-medium text-text-faint">
                    Subscribed link{account.accountIdentifier ? ` · ${account.accountIdentifier}` : ''}
                    {account.lastSyncAt
                      ? ` · last synced ${new Date(account.lastSyncAt).toLocaleString('en-GB')}`
                      : ' · never synced'}
                  </div>
                  {account.lastError && (
                    <div className="mt-0.5 text-[13px] font-semibold text-warn">{account.lastError}</div>
                  )}
                </div>
              </div>

              <div className="flex shrink-0 gap-2">
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => void syncNow(account.id)}>
                  Sync
                </Button>
                <Button variant="danger" size="sm" disabled={busy} onClick={() => void disconnect(account)}>
                  Disconnect
                </Button>
              </div>
            </div>

            {own.map((calendar) => (
              // One hairline above each calendar; its two rows sit together beneath it.
              <div key={calendar.id} className="border-t border-border [&>div]:border-t-0">
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
                      className={rowSelect}
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
          </SettingsCard>
        )
      })}

      {/* iCloud is the only connection that can be written to, so it gets its own card
          rather than hiding behind the subscribe box that cannot. */}
      <div className="flex flex-col gap-2.5 rounded-card bg-area-stage-tint p-4 wide:p-5">
        <h3 className="text-[16px] font-bold text-accent-soft">Connect iCloud</h3>
        <p className="max-w-xl text-[14px] leading-[1.45] font-medium text-text-dim">
          The only connection that works in both directions. Uurwerk reads your calendars and
          writes your plan to a separate <strong className="text-text">Uurwerk</strong> calendar
          it creates — your own calendars are never written to.
        </p>
        <p className="max-w-xl text-[14px] leading-[1.45] font-medium text-text-dim">
          You need an <strong className="text-text">app-specific password</strong>, not your
          Apple ID password. On your iPhone: Settings → your name → Sign-In &amp; Security →
          App-Specific Passwords. It looks like <span className="font-code text-[13px]">abcd-efgh-ijkl-mnop</span>.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <input
            value={appleId}
            onChange={(event) => setAppleId(event.target.value)}
            placeholder="Apple ID (e-mail)"
            autoComplete="off"
            className={`${inputField} basis-[220px]`}
          />
          <input
            value={appPassword}
            onChange={(event) => setAppPassword(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && void connectIcloud()}
            placeholder="abcd-efgh-ijkl-mnop"
            // Masked like any other credential: this is a real key to your iCloud data.
            type="password"
            autoComplete="off"
            className={`${inputField} basis-[200px] font-code`}
          />
          <Button
            variant="primary"
            className="w-full wide:w-auto"
            disabled={busy || !appleId.trim() || !appPassword.trim()}
            onClick={() => void connectIcloud()}
          >
            Connect
          </Button>
        </div>

        <p className="text-[12px] leading-[1.45] font-medium text-accent-soft">
          The password is encrypted with Windows DPAPI and never written to the database. Revoke
          it any time from the same Apple screen — it grants access to iCloud data only, and
          cannot change your account.
        </p>
      </div>

      <SettingsCard className="flex flex-col gap-2.5 p-4 wide:p-5">
        <h3 className="text-[16px] font-bold text-text">Subscribe to a calendar</h3>
        <p className="max-w-xl text-[14px] leading-[1.45] font-medium text-text-dim">
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
            className={`${inputField} basis-[280px]`}
          />
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Name (optional)"
            className={`${inputField} basis-[180px]`}
          />
          <Button
            variant="primary"
            className="w-full wide:w-auto"
            disabled={busy || !url.trim()}
            onClick={() => void connect()}
          >
            Subscribe
          </Button>
        </div>

        <p className="text-[12px] leading-[1.45] font-medium text-text-faint">
          The publisher decides how fresh this is — Microsoft regenerates a published calendar on
          its own schedule, sometimes hours behind. The link is stored encrypted, like your other
          credentials.
        </p>
      </SettingsCard>
    </SettingsSection>
  )
}
