/**
 * Connecting and refreshing calendar accounts.
 *
 * The only file outside this folder that knows a provider exists is `ipc.ts`, and it only
 * knows these four functions.
 *
 * A published ICS link is a credential: anyone holding it can read the calendar. So it goes
 * into the same encrypted vault as the SMTP password rather than into the database, and the
 * account row keeps only the host, which is enough to tell two subscriptions apart on screen.
 */

import type { Backend } from '../ipc.js'
import { log } from '../logger.js'
import { getSecret, setSecret } from '../secrets.js'
import { CalDavProvider } from './caldav.js'
import { IcsProvider } from './ics.js'
import type { CalendarProvider } from './provider.js'
import { importEvents, markMissingAsDeleted, type SyncOutcome } from './sync.js'

/** How far around today a sync looks. Wide enough for a fortnight's planning either way. */
const WINDOW_BACK_DAYS = 30
const WINDOW_FORWARD_DAYS = 120

const secretKeyFor = (accountId: string): `ics:${string}` => `ics:${accountId}`
const icloudKeyFor = (accountId: string): `icloud:${string}` => `icloud:${accountId}`

/** The calendar Uurwerk creates and owns; the only one it ever writes to. */
export const UURWERK_CALENDAR_NAME = 'Uurwerk'

/**
 * Adds a subscribed calendar.
 *
 * The link is fetched before anything is written: a connection that stores a broken URL and
 * reports success is how you end up with an empty planner and no idea why.
 */
export async function connectIcs(
  backend: Backend,
  url: string,
  label?: string
): Promise<{ accountId: string; calendarId: string; outcome: SyncOutcome }> {
  const trimmed = url.trim()
  if (!/^(https?|webcal):\/\//i.test(trimmed)) {
    throw new Error('That does not look like a calendar link. It should start with https:// or webcal://.')
  }

  const provider = new IcsProvider(trimmed, label ?? 'Subscribed calendar')
  const identity = await provider.connect()

  const account = backend.store.calendar.addAccount({
    provider: 'ics',
    authMethod: 'url',
    displayName: label?.trim() || identity.displayName,
    accountIdentifier: identity.accountIdentifier
  })

  // The URL never touches the database.
  setSecret(secretKeyFor(account.id), trimmed)

  const [remote] = await provider.getCalendars()
  const calendar = backend.store.calendar.upsertCalendar({
    accountId: account.id,
    externalId: remote?.externalId ?? trimmed,
    name: remote?.name ?? identity.displayName,
    writable: false
  })

  const outcome = await syncAccount(backend, account.id)
  log.info('Subscribed calendar connected.', { account: account.id, ...outcome })

  return { accountId: account.id, calendarId: calendar.id, outcome }
}

/**
 * Connects an iCloud account over CalDAV.
 *
 * The credential is checked before anything is written, same as a subscribed link: an
 * account row that exists with a password that does not work is worse than no account.
 *
 * Every calendar found is registered, but only for reading. The one Uurwerk writes to is
 * created separately and on purpose — see `ensureUurwerkCalendar`. That split is the whole
 * safety argument: two writers on your personal calendar is how a sync bug eats a real
 * appointment, so Uurwerk never becomes the second writer on one.
 */
export async function connectIcloud(
  backend: Backend,
  appleId: string,
  appPassword: string
): Promise<{ accountId: string; outcome: SyncOutcome }> {
  const username = appleId.trim()
  const password = appPassword.trim()

  if (!username.includes('@')) {
    throw new Error('That does not look like an Apple ID. It should be an e-mail address.')
  }
  // Apple issues these as four groups of four letters. Catching an account password here is
  // worth it: the error from iCloud is a bare 401 that explains nothing.
  if (!/^[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}$/i.test(password)) {
    throw new Error(
      'That is not an app-specific password. Generate one at account.apple.com under ' +
        'Sign-In and Security — it looks like abcd-efgh-ijkl-mnop.'
    )
  }

  const provider = new CalDavProvider({ username, appPassword: password })
  const identity = await provider.connect()

  const account = backend.store.calendar.addAccount({
    provider: 'icloud',
    authMethod: 'app-password',
    displayName: identity.displayName,
    accountIdentifier: identity.accountIdentifier
  })

  // The password never touches the database.
  setSecret(icloudKeyFor(account.id), password)

  for (const remote of await provider.getCalendars()) {
    backend.store.calendar.upsertCalendar({
      accountId: account.id,
      externalId: remote.externalId,
      name: remote.name,
      // Read-only from Uurwerk's side, whatever the server would permit. The calendar it
      // writes to is its own.
      writable: false
    })
  }

  const outcome = await syncAccount(backend, account.id)
  log.info('iCloud connected.', { account: account.id, ...outcome })

  return { accountId: account.id, outcome }
}

/**
 * Finds or creates the calendar Uurwerk owns, and remembers which one it is.
 *
 * Kept out of `connectIcloud` because it writes to your iCloud, and connecting should not
 * silently create things there. It runs the first time you actually ask for your plan to
 * appear on your phone.
 */
export async function ensureUurwerkCalendar(
  backend: Backend,
  accountId: string
): Promise<string> {
  const provider = providerFor(backend, accountId)
  if (!(provider instanceof CalDavProvider)) {
    throw new Error('Only an iCloud account can hold the Uurwerk calendar.')
  }

  const existing = (await provider.getCalendars()).find(
    (calendar) => calendar.name === UURWERK_CALENDAR_NAME
  )
  const remote = existing ?? (await provider.createCalendar(UURWERK_CALENDAR_NAME))

  const local = backend.store.calendar.upsertCalendar({
    accountId,
    externalId: remote.externalId,
    name: remote.name,
    writable: true
  })

  // Nothing on it should ever block your planning: it *is* your planning.
  backend.store.calendar.updateCalendar(local.id, { ignoreForPlanning: true })
  return local.id
}

/** Forgets an account, its calendars, its links — and its credential. */
export async function disconnectAccount(backend: Backend, accountId: string): Promise<void> {
  const account = backend.store.calendar.account(accountId)
  if (account?.provider === 'icloud') setSecret(icloudKeyFor(accountId), '')
  else setSecret(secretKeyFor(accountId), '')

  backend.store.calendar.removeAccount(accountId)
  log.info('Calendar account disconnected.', { accountId })
}

/**
 * The CalDAV provider for an account, or a readable refusal.
 *
 * Exported so the push path builds its provider the same way sync does — one place that
 * knows where the credential lives, rather than two that could drift.
 */
export function calDavProviderFor(backend: Backend, accountId: string): CalDavProvider {
  const provider = providerFor(backend, accountId)
  if (!(provider instanceof CalDavProvider)) {
    throw new Error('Only an iCloud account can be written to.')
  }
  return provider
}

function providerFor(backend: Backend, accountId: string): CalendarProvider {
  const account = backend.store.calendar.account(accountId)
  if (!account) throw new Error(`Calendar account not found: ${accountId}`)

  if (account.provider === 'ics') {
    const url = getSecret(secretKeyFor(accountId))
    if (!url) {
      throw new Error(
        `The link for “${account.displayName}” is missing from the vault. Reconnect the calendar.`
      )
    }
    return new IcsProvider(url, account.displayName)
  }

  if (account.provider === 'icloud') {
    const appPassword = getSecret(icloudKeyFor(accountId))
    if (!appPassword || !account.accountIdentifier) {
      throw new Error(
        `The password for “${account.displayName}” is missing from the vault. Reconnect iCloud.`
      )
    }
    return new CalDavProvider({
      username: account.accountIdentifier,
      appPassword
    })
  }

  // Outlook lands here when its provider is built.
  throw new Error(`No provider is available for ${account.provider} yet.`)
}

/**
 * Refreshes one account.
 *
 * Failure is recorded on the account rather than thrown away, so the Settings screen can
 * say what went wrong instead of silently showing a stale calendar.
 */
export async function syncAccount(backend: Backend, accountId: string): Promise<SyncOutcome> {
  const store = backend.store
  const account = store.calendar.account(accountId)
  if (!account) throw new Error(`Calendar account not found: ${accountId}`)

  const day = 86_400_000
  const from = Date.now() - WINDOW_BACK_DAYS * day
  const to = Date.now() + WINDOW_FORWARD_DAYS * day

  try {
    const provider = providerFor(backend, accountId)
    const calendars = store.calendar.calendars(accountId)
    if (calendars.length === 0) throw new Error('That account has no calendar selected.')

    const outcome: SyncOutcome = {
      imported: 0,
      updated: 0,
      cancelled: 0,
      autoClassified: 0,
      pending: 0
    }
    const seen = new Set<string>()
    let syncToken: string | null = null

    if (provider instanceof CalDavProvider) {
      // One request per calendar, so every event is filed against the calendar it actually
      // came from — the per-calendar defaults that stop the classifier asking depend on it.
      for (const calendar of calendars) {
        if (!calendar.selected) continue
        // Never read back the calendar we write to. Importing our own plan blocks would
        // turn them into appointments, which would then block the planner that created
        // them — a feedback loop that fills the week with its own output.
        if (calendar.name === UURWERK_CALENDAR_NAME) continue

        const events = await provider.eventsIn(calendar.externalId, from, to)
        for (const event of events) seen.add(event.uid)

        const result = importEvents({
          store,
          accountId,
          calendarId: calendar.id,
          origin: account.provider,
          events
        })
        outcome.imported += result.imported
        outcome.updated += result.updated
        outcome.cancelled += result.cancelled
        outcome.autoClassified += result.autoClassified
        outcome.pending += result.pending
      }
    } else {
      const calendar = calendars[0]!
      const fetched = await provider.getEvents(from, to, store.calendar.syncToken(accountId))
      syncToken = fetched.syncToken
      for (const event of fetched.events) seen.add(event.uid)

      const result = importEvents({
        store,
        accountId,
        calendarId: calendar.id,
        origin: account.provider,
        events: fetched.events.filter(() => calendar.selected)
      })
      Object.assign(outcome, result)
    }

    // Only a provider that returns everything can conclude that a missing event is gone.
    if (!provider.capabilities.incrementalSync) {
      markMissingAsDeleted({
        store,
        accountId,
        seenExternalIds: seen,
        windowStartMs: from,
        windowEndMs: to
      })
    }

    store.calendar.updateAccount(accountId, {
      status: 'connected',
      lastSyncAt: Date.now(),
      lastError: null,
      syncToken
    })

    return outcome
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    store.calendar.updateAccount(accountId, { status: 'error', lastError: message })
    log.warn('Calendar sync failed.', { accountId, message })
    throw error
  }
}

/** Refreshes everything connected. Used on launch and by the manual button. */
export async function syncAllAccounts(backend: Backend): Promise<void> {
  for (const account of backend.store.calendar.accounts()) {
    if (account.status === 'disconnected') continue
    try {
      await syncAccount(backend, account.id)
    } catch {
      // Already recorded on the account; one broken subscription must not stop the others.
    }
  }
}
