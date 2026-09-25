/**
 * ★ What the backend needs from the machine it runs on. ★
 *
 * The backend is the same code on the laptop and on the VPS. Everything that differs
 * between the two — where secrets live, how an event reaches a screen, whether there is
 * a screen to take a screenshot of at all — comes in through this one interface.
 *
 * The desktop app installs an Electron host (packages/main/src/host.ts); the server
 * installs its own. A backend without a host installed is a programming error and says so.
 */

import type { TimeTrackerAPI } from '@core/contract/api.js'
import type { AppEventName, AppEvents } from '@core/contract/events.js'

/**
 * `ics:<accountId>` covers subscribed calendars: a published calendar link is a credential
 * — anyone holding it can read the calendar — so it belongs in the vault beside the
 * passwords rather than in the database.
 */
// `icloud:<accountId>` holds an app-specific password. Only the password: the Apple ID it
// belongs to is on the account row, because it is an identifier rather than a credential and
// the Settings screen has to be able to show you which account is connected.
export type SecretKey =
  | 'smtpPassword'
  | 'publishToken'
  // The token this device syncs with. Made on the server, shown once, kept here.
  | 'deviceToken'
  | `ics:${string}`
  | `icloud:${string}`

export interface SecretVault {
  get(key: SecretKey): string | null
  set(key: SecretKey, value: string): void
  has(key: SecretKey): boolean
}

export interface Host {
  /** Broadcasts a typed event to whatever is listening: windows on the laptop, SSE on the server. */
  emit<K extends AppEventName>(event: K, payload: AppEvents[K]): void
  secrets: SecretVault
  /** Where a generated .docx goes, given the configured folder (empty = the default). */
  reportDir(configured: string): string
  openPath(path: string): Promise<void>
  openExternal(url: string): Promise<void>
  showItemInFolder(path: string): void
  /** Only a machine with a screen can take screenshots or encode a timelapse. */
  capture: Pick<TimeTrackerAPI['capture'], 'markNow' | 'buildTimelapse'>
  startup: TimeTrackerAPI['startup']
  window: TimeTrackerAPI['window']
  /** Restart the app, e.g. to open a database downloaded from the server. */
  relaunch(): Promise<void>
  /** This copy and the server. Only a device has one; on the server every call refuses. */
  sync: TimeTrackerAPI['sync']
  /**
   * Where the bytes of a screenshot or timelapse are on this machine. The laptop keeps them
   * where it wrote them; the server keeps uploads under the artifact id, because the path in
   * the row is the laptop's.
   */
  fileFor(artifact: { id: string; path: string }): string
  /**
   * Where published files go when this machine *is* the publishing server. Without one,
   * publishing uploads over HTTP to the configured publish URL, as before.
   */
  publishSink?: {
    put(name: string, bytes: Uint8Array): Promise<void>
    remove(name: string): Promise<void>
  }
}

let installed: Host | null = null

export function installHost(host: Host): void {
  installed = host
}

export function host(): Host {
  if (!installed) throw new Error('No backend host installed — call installHost() at startup.')
  return installed
}

/** Shorthand for the one host call nearly every handler makes. */
export function emitEvent<K extends AppEventName>(event: K, payload: AppEvents[K]): void {
  host().emit(event, payload)
}

/** For hosts that lack a capability entirely, such as the server with no screen. */
export const unavailable = (what: string) => async (): Promise<never> => {
  throw new Error(`${what} is not available on this machine.`)
}
