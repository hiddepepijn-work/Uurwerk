import type {
  CalendarAccount,
  CalendarAccountStatus,
  CalendarAuthMethod,
  CalendarEvent,
  CalendarEventKind,
  CalendarEventLink,
  CalendarOrigin,
  CalendarProviderId,
  CalendarSource,
  ClassificationStatus,
  NewCalendarEvent,
  RegistrationMode,
  SyncStatus,
  TravelDirection
} from '../../contract/types.js'
import { Db, fromDbBool, newId, toDbBool } from '../connection.js'

// ------------------------------------------------------------------- rows

interface AccountRow {
  id: string
  provider: CalendarProviderId
  auth_method: CalendarAuthMethod
  display_name: string
  account_identifier: string | null
  status: CalendarAccountStatus
  sync_token: string | null
  last_sync_at: number | null
  last_error: string | null
}

interface CalendarRow {
  id: string
  account_id: string
  external_id: string
  name: string
  color: string | null
  selected: number
  writable: number
  default_area_id: string | null
  default_organization_id: string | null
  default_project_id: string | null
  default_work_type_id: string | null
  ignore_for_planning: number
}

interface EventRow {
  id: string
  title: string
  description: string | null
  location: string | null
  starts_at: number
  ends_at: number
  all_day: number
  event_kind: CalendarEventKind
  parent_event_id: string | null
  travel_direction: TravelDirection | null
  travel_detached: number
  recurrence_rule: string | null
  recurrence_master_id: string | null
  original_starts_at: number | null
  cancelled: number
  organizer: string | null
  attendees: string
  origin: CalendarOrigin
  area_id: string | null
  organization_id: string | null
  project_id: string | null
  work_type_id: string | null
  classification_status: ClassificationStatus
  confidence: number | null
  include_in_planning: number
  registration_mode: RegistrationMode
  counts_as_worked: number
  confirmed_min: number | null
  reconciled_segment_id: string | null
  local_updated_at: number
  deleted_at: number | null
}

interface LinkRow {
  id: string
  event_id: string
  account_id: string
  calendar_id: string | null
  external_id: string
  etag: string | null
  external_updated_at: number | null
  last_synced_at: number | null
  sync_status: SyncStatus
}

// ---------------------------------------------------------------- mappers

const mapAccount = (row: AccountRow): CalendarAccount => ({
  id: row.id,
  provider: row.provider,
  authMethod: row.auth_method,
  displayName: row.display_name,
  accountIdentifier: row.account_identifier,
  status: row.status,
  lastSyncAt: row.last_sync_at,
  lastError: row.last_error
})

const mapCalendar = (row: CalendarRow): CalendarSource => ({
  id: row.id,
  accountId: row.account_id,
  externalId: row.external_id,
  name: row.name,
  color: row.color,
  selected: fromDbBool(row.selected),
  writable: fromDbBool(row.writable),
  defaultAreaId: row.default_area_id,
  defaultOrganizationId: row.default_organization_id,
  defaultProjectId: row.default_project_id,
  defaultWorkTypeId: row.default_work_type_id,
  ignoreForPlanning: fromDbBool(row.ignore_for_planning)
})

/** A corrupt attendee list must not take a calendar down; it becomes an empty one. */
function parseAttendees(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

const mapEvent = (row: EventRow): CalendarEvent => ({
  id: row.id,
  title: row.title,
  description: row.description,
  location: row.location,
  startsAt: row.starts_at,
  endsAt: row.ends_at,
  allDay: fromDbBool(row.all_day),
  kind: row.event_kind,
  parentEventId: row.parent_event_id,
  travelDirection: row.travel_direction,
  travelDetached: fromDbBool(row.travel_detached),
  recurrenceRule: row.recurrence_rule,
  recurrenceMasterId: row.recurrence_master_id,
  originalStartsAt: row.original_starts_at,
  cancelled: fromDbBool(row.cancelled),
  organizer: row.organizer,
  attendees: parseAttendees(row.attendees),
  origin: row.origin,
  areaId: row.area_id,
  organizationId: row.organization_id,
  projectId: row.project_id,
  workTypeId: row.work_type_id,
  classificationStatus: row.classification_status,
  confidence: row.confidence,
  includeInPlanning: fromDbBool(row.include_in_planning),
  registrationMode: row.registration_mode,
  countsAsWorked: fromDbBool(row.counts_as_worked),
  confirmedMin: row.confirmed_min,
  reconciledSegmentId: row.reconciled_segment_id,
  localUpdatedAt: row.local_updated_at,
  deletedAt: row.deleted_at
})

const mapLink = (row: LinkRow): CalendarEventLink => ({
  id: row.id,
  eventId: row.event_id,
  accountId: row.account_id,
  calendarId: row.calendar_id,
  externalId: row.external_id,
  etag: row.etag,
  externalUpdatedAt: row.external_updated_at,
  lastSyncedAt: row.last_synced_at,
  syncStatus: row.sync_status
})

/**
 * Calendars, their events, and the links that tie one logical event to every provider that
 * holds a copy of it.
 *
 * The one method worth reading twice is `eventForExternalId`. Every import path goes through
 * it first, and it is the reason an event Uurwerk created and pushed to Outlook does not
 * come back through the next sync as a stranger.
 */
export class CalendarRepo {
  constructor(private readonly db: Db) {}

  // ----------------------------------------------------------- accounts

  accounts(): CalendarAccount[] {
    return this.db
      .all<AccountRow>('SELECT * FROM calendar_accounts ORDER BY created_at')
      .map(mapAccount)
  }

  account(id: string): CalendarAccount | null {
    const row = this.db.get<AccountRow>('SELECT * FROM calendar_accounts WHERE id = ?', [id])
    return row ? mapAccount(row) : null
  }

  addAccount(input: {
    provider: CalendarProviderId
    authMethod?: CalendarAuthMethod
    displayName: string
    accountIdentifier?: string | null
  }): CalendarAccount {
    const id = newId()
    this.db.run(
      `INSERT INTO calendar_accounts
         (id, provider, auth_method, display_name, account_identifier, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'connected', ?)`,
      [
        id,
        input.provider,
        input.authMethod ?? 'oauth',
        input.displayName,
        input.accountIdentifier ?? null,
        Date.now()
      ]
    )
    return this.account(id)!
  }

  updateAccount(
    id: string,
    patch: Partial<{
      displayName: string
      status: CalendarAccountStatus
      syncToken: string | null
      lastSyncAt: number | null
      lastError: string | null
      authMethod: CalendarAuthMethod
    }>
  ): CalendarAccount {
    const current = this.account(id)
    if (!current) throw new Error(`Calendar account not found: ${id}`)

    const row = this.db.get<AccountRow>('SELECT * FROM calendar_accounts WHERE id = ?', [id])!
    this.db.run(
      `UPDATE calendar_accounts SET
         display_name = ?, status = ?, sync_token = ?, last_sync_at = ?, last_error = ?,
         auth_method = ?
       WHERE id = ?`,
      [
        patch.displayName ?? row.display_name,
        patch.status ?? row.status,
        patch.syncToken !== undefined ? patch.syncToken : row.sync_token,
        patch.lastSyncAt !== undefined ? patch.lastSyncAt : row.last_sync_at,
        patch.lastError !== undefined ? patch.lastError : row.last_error,
        patch.authMethod ?? row.auth_method,
        id
      ]
    )
    return this.account(id)!
  }

  syncToken(accountId: string): string | null {
    return (
      this.db.get<{ sync_token: string | null }>(
        'SELECT sync_token FROM calendar_accounts WHERE id = ?',
        [accountId]
      )?.sync_token ?? null
    )
  }

  /** Disconnecting removes the account and, by cascade, its calendars and links. */
  removeAccount(id: string): void {
    this.db.run('DELETE FROM calendar_accounts WHERE id = ?', [id])
  }

  // ---------------------------------------------------------- calendars

  calendars(accountId?: string): CalendarSource[] {
    const sql = accountId
      ? 'SELECT * FROM calendars WHERE account_id = ? ORDER BY name COLLATE NOCASE'
      : 'SELECT * FROM calendars ORDER BY name COLLATE NOCASE'
    return this.db.all<CalendarRow>(sql, accountId ? [accountId] : []).map(mapCalendar)
  }

  calendar(id: string): CalendarSource | null {
    const row = this.db.get<CalendarRow>('SELECT * FROM calendars WHERE id = ?', [id])
    return row ? mapCalendar(row) : null
  }

  /** Idempotent: a provider listing its calendars again must not duplicate them. */
  upsertCalendar(input: {
    accountId: string
    externalId: string
    name: string
    color?: string | null
    writable?: boolean
  }): CalendarSource {
    const existing = this.db.get<CalendarRow>(
      'SELECT * FROM calendars WHERE account_id = ? AND external_id = ?',
      [input.accountId, input.externalId]
    )

    if (existing) {
      this.db.run('UPDATE calendars SET name = ?, color = ?, writable = ? WHERE id = ?', [
        input.name,
        input.color ?? existing.color,
        toDbBool(input.writable ?? fromDbBool(existing.writable)),
        existing.id
      ])
      return this.calendar(existing.id)!
    }

    const id = newId()
    this.db.run(
      `INSERT INTO calendars (id, account_id, external_id, name, color, selected, writable)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
      [id, input.accountId, input.externalId, input.name, input.color ?? null, toDbBool(input.writable ?? false)]
    )
    return this.calendar(id)!
  }

  updateCalendar(id: string, patch: Partial<CalendarSource>): CalendarSource {
    const current = this.calendar(id)
    if (!current) throw new Error(`Calendar not found: ${id}`)

    const next = { ...current, ...patch, id }
    this.db.run(
      `UPDATE calendars SET
         name = ?, selected = ?, writable = ?, default_area_id = ?,
         default_organization_id = ?, default_project_id = ?, default_work_type_id = ?,
         ignore_for_planning = ?
       WHERE id = ?`,
      [
        next.name,
        toDbBool(next.selected),
        toDbBool(next.writable),
        next.defaultAreaId,
        next.defaultOrganizationId,
        next.defaultProjectId,
        next.defaultWorkTypeId,
        toDbBool(next.ignoreForPlanning),
        id
      ]
    )
    return this.calendar(id)!
  }

  // ------------------------------------------------------------- events

  event(id: string): CalendarEvent | null {
    const row = this.db.get<EventRow>('SELECT * FROM calendar_events WHERE id = ?', [id])
    return row ? mapEvent(row) : null
  }

  /** Events overlapping a range: a meeting spanning midnight belongs to both days. */
  eventsInRange(startMs: number, endMs: number): CalendarEvent[] {
    return this.db
      .all<EventRow>(
        `SELECT * FROM calendar_events
         WHERE deleted_at IS NULL AND cancelled = 0
           AND starts_at < ? AND ends_at > ?
         ORDER BY starts_at`,
        [endMs, startMs]
      )
      .map(mapEvent)
  }

  /** Everything waiting on a decision — what the classification popup works through. */
  unclassified(): CalendarEvent[] {
    return this.db
      .all<EventRow>(
        `SELECT * FROM calendar_events
         WHERE deleted_at IS NULL AND cancelled = 0
           AND event_kind = 'appointment'
           AND classification_status IN ('unclassified','suggested')
         ORDER BY starts_at`
      )
      .map(mapEvent)
  }

  /** The travel blocks belonging to an appointment. */
  travelFor(eventId: string): CalendarEvent[] {
    return this.db
      .all<EventRow>(
        `SELECT * FROM calendar_events
         WHERE parent_event_id = ? AND deleted_at IS NULL
         ORDER BY starts_at`,
        [eventId]
      )
      .map(mapEvent)
  }

  createEvent(input: NewCalendarEvent): CalendarEvent {
    if (input.endsAt <= input.startsAt) {
      throw new Error('A calendar event has to end after it starts.')
    }

    const id = newId()
    const now = Date.now()

    this.db.run(
      `INSERT INTO calendar_events
         (id, title, description, location, starts_at, ends_at, all_day, event_kind,
          parent_event_id, travel_direction, travel_detached, recurrence_rule,
          recurrence_master_id, original_starts_at, cancelled, organizer, attendees, origin,
          area_id, organization_id, project_id, work_type_id, classification_status,
          confidence, include_in_planning, registration_mode, counts_as_worked,
          confirmed_min, reconciled_segment_id, local_updated_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               NULL, NULL, ?, ?)`,
      [
        id,
        input.title.trim(),
        input.description ?? null,
        input.location ?? null,
        input.startsAt,
        input.endsAt,
        toDbBool(input.allDay ?? false),
        input.kind ?? 'appointment',
        input.parentEventId ?? null,
        input.travelDirection ?? null,
        input.recurrenceRule ?? null,
        input.recurrenceMasterId ?? null,
        input.originalStartsAt ?? null,
        input.organizer ?? null,
        JSON.stringify(input.attendees ?? []),
        input.origin ?? 'uurwerk',
        input.areaId ?? null,
        input.organizationId ?? null,
        input.projectId ?? null,
        input.workTypeId ?? null,
        input.classificationStatus ?? 'unclassified',
        input.confidence ?? null,
        toDbBool(input.includeInPlanning ?? true),
        input.registrationMode ?? 'none',
        toDbBool(input.countsAsWorked ?? false),
        now,
        now
      ]
    )
    return this.event(id)!
  }

  updateEvent(id: string, patch: Partial<CalendarEvent>): CalendarEvent {
    const current = this.event(id)
    if (!current) throw new Error(`Calendar event not found: ${id}`)

    const next = { ...current, ...patch, id }
    if (next.endsAt <= next.startsAt) {
      throw new Error('A calendar event has to end after it starts.')
    }

    this.db.run(
      `UPDATE calendar_events SET
         title = ?, description = ?, location = ?, starts_at = ?, ends_at = ?, all_day = ?,
         travel_detached = ?, cancelled = ?, organizer = ?, attendees = ?,
         area_id = ?, organization_id = ?, project_id = ?, work_type_id = ?,
         classification_status = ?, confidence = ?, include_in_planning = ?,
         registration_mode = ?, counts_as_worked = ?, confirmed_min = ?,
         reconciled_segment_id = ?, local_updated_at = ?, deleted_at = ?
       WHERE id = ?`,
      [
        next.title,
        next.description,
        next.location,
        next.startsAt,
        next.endsAt,
        toDbBool(next.allDay),
        toDbBool(next.travelDetached),
        toDbBool(next.cancelled),
        next.organizer,
        JSON.stringify(next.attendees),
        next.areaId,
        next.organizationId,
        next.projectId,
        next.workTypeId,
        next.classificationStatus,
        next.confidence,
        toDbBool(next.includeInPlanning),
        next.registrationMode,
        toDbBool(next.countsAsWorked),
        next.confirmedMin,
        next.reconciledSegmentId,
        Date.now(),
        next.deletedAt,
        id
      ]
    )
    return this.event(id)!
  }

  /**
   * Marks an event gone without losing it.
   *
   * A hard delete would take the links with it, and the next sync would then treat the
   * provider's copy as a brand new event and import it straight back.
   */
  softDelete(id: string): void {
    this.db.run('UPDATE calendar_events SET deleted_at = ?, local_updated_at = ? WHERE id = ?', [
      Date.now(),
      Date.now(),
      id
    ])
  }

  // -------------------------------------------------------------- links

  links(eventId: string): CalendarEventLink[] {
    return this.db
      .all<LinkRow>('SELECT * FROM calendar_event_links WHERE event_id = ?', [eventId])
      .map(mapLink)
  }

  /**
   * ★ The anti-duplicate lookup. ★
   *
   * Every import asks this first. A hit means the provider is describing an event we
   * already hold — possibly one we created ourselves and pushed to them a minute ago — so
   * it is updated in place. A miss is the only thing that may create a new event.
   */
  eventForExternalId(accountId: string, externalId: string): CalendarEvent | null {
    const link = this.db.get<LinkRow>(
      'SELECT * FROM calendar_event_links WHERE account_id = ? AND external_id = ?',
      [accountId, externalId]
    )
    return link ? this.event(link.event_id) : null
  }

  linkFor(accountId: string, externalId: string): CalendarEventLink | null {
    const row = this.db.get<LinkRow>(
      'SELECT * FROM calendar_event_links WHERE account_id = ? AND external_id = ?',
      [accountId, externalId]
    )
    return row ? mapLink(row) : null
  }

  /** Records — or refreshes — how one provider knows this event. */
  linkEvent(input: {
    eventId: string
    accountId: string
    calendarId?: string | null
    externalId: string
    etag?: string | null
    externalUpdatedAt?: number | null
    syncStatus?: SyncStatus
  }): CalendarEventLink {
    const existing = this.linkFor(input.accountId, input.externalId)
    const now = Date.now()

    if (existing) {
      this.db.run(
        `UPDATE calendar_event_links SET
           event_id = ?, calendar_id = ?, etag = ?, external_updated_at = ?,
           last_synced_at = ?, sync_status = ?
         WHERE id = ?`,
        [
          input.eventId,
          input.calendarId ?? existing.calendarId,
          input.etag ?? existing.etag,
          input.externalUpdatedAt ?? existing.externalUpdatedAt,
          now,
          input.syncStatus ?? 'synced',
          existing.id
        ]
      )
      return this.linkFor(input.accountId, input.externalId)!
    }

    const id = newId()
    this.db.run(
      `INSERT INTO calendar_event_links
         (id, event_id, account_id, calendar_id, external_id, etag, external_updated_at,
          last_synced_at, sync_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.eventId,
        input.accountId,
        input.calendarId ?? null,
        input.externalId,
        input.etag ?? null,
        input.externalUpdatedAt ?? null,
        now,
        input.syncStatus ?? 'synced'
      ]
    )
    return this.linkFor(input.accountId, input.externalId)!
  }

  setSyncStatus(linkId: string, status: SyncStatus): void {
    this.db.run('UPDATE calendar_event_links SET sync_status = ? WHERE id = ?', [status, linkId])
  }

  /** Everything with local changes a provider has not been told about yet. */
  pendingPush(accountId: string): CalendarEventLink[] {
    return this.db
      .all<LinkRow>(
        `SELECT * FROM calendar_event_links
         WHERE account_id = ? AND sync_status IN ('local_changed','deleted')`,
        [accountId]
      )
      .map(mapLink)
  }
}
