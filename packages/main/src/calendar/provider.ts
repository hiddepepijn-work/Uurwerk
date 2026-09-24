/**
 * What every calendar provider has to be able to do.
 *
 * The point of the interface is that the rest of Uurwerk never learns which service is on
 * the other end. Adding Google later, or swapping iCloud's authentication when Apple's
 * account authorisation becomes usable from Windows, should touch one file in this folder
 * and nothing else.
 *
 * Providers differ in what they *can* do, and the interface says so rather than pretending
 * otherwise: a subscribed ICS link can be read and never written, while Graph can do both.
 * `capabilities` is how the UI knows to grey out "create in this calendar" instead of
 * offering something that will fail.
 */

import type { ParsedEvent } from './ics-parse.js'

export interface ProviderCapabilities {
  read: boolean
  write: boolean
  /** Whether the provider can report only what changed since last time. */
  incrementalSync: boolean
}

export interface ProviderCalendar {
  externalId: string
  name: string
  color?: string | null
  writable: boolean
}

export interface ProviderEvents {
  events: ParsedEvent[]
  /** Passed back on the next call by providers that support it; null when unsupported. */
  syncToken: string | null
  /**
   * The server said nothing changed, so `events` is empty because there was nothing to
   * fetch — not because the calendar is empty.
   *
   * The distinction matters: a caller that treats an unchanged calendar as an empty one
   * would delete every event it holds.
   */
  notModified?: boolean
}

/**
 * A connected calendar source.
 *
 * `connect` is deliberately allowed to be slow and to fail loudly: it is the moment a
 * credential is checked, and a connection that reports success while returning nothing is
 * the worst outcome for the person using it.
 */
export interface CalendarProvider {
  readonly id: 'outlook' | 'icloud' | 'ics'
  readonly capabilities: ProviderCapabilities

  /** Verifies the credential and returns what to call this account. */
  connect(): Promise<{ displayName: string; accountIdentifier: string | null }>
  disconnect(): Promise<void>

  getCalendars(): Promise<ProviderCalendar[]>

  /**
   * Events overlapping a window.
   *
   * A window rather than everything: a calendar with ten years of history is not something
   * to pull down to show next week.
   */
  getEvents(fromMs: number, toMs: number, syncToken?: string | null): Promise<ProviderEvents>

  createEvent?(calendarExternalId: string, event: ParsedEvent): Promise<{ externalId: string; etag: string | null }>
  updateEvent?(calendarExternalId: string, externalId: string, event: ParsedEvent): Promise<{ etag: string | null }>
  deleteEvent?(calendarExternalId: string, externalId: string): Promise<void>
}

/** Thrown when something is asked of a provider that cannot do it, e.g. writing to a link. */
export class UnsupportedOperationError extends Error {
  constructor(provider: string, operation: string) {
    super(`${provider} cannot ${operation}.`)
    this.name = 'UnsupportedOperationError'
  }
}
