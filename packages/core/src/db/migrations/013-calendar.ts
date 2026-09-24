import type { Migration } from './index.js'

/**
 * Calendars: accounts, the events themselves, and what Uurwerk knows about them.
 *
 * Four ideas hold this together, and each exists because the obvious shortcut breaks later.
 *
 * **A logical event, and its representations.** `calendar_events` is the event as a fact —
 * one row for "the project meeting on the 18th". `calendar_event_links` is how that fact
 * appears in each provider, with the external id and etag. The unique index on
 * (account_id, external_id) is what stops the loop: an event Uurwerk pushed to Outlook comes
 * back on the next poll carrying an id we already have a link for, so it updates the event
 * we already have instead of importing a copy of our own work.
 *
 * **Travel is an event, not two numbers.** An outbound and a return block are real periods
 * that occupy the calendar, block planning, sync outward and appear in reports. Modelling
 * them as `event_kind = 'travel'` children of the appointment means every one of those
 * behaviours comes from the machinery that already exists, instead of five special cases
 * for a pair of integer columns.
 *
 * **Calendar time is not tracked time.** An hour in the calendar and fifty-five minutes on
 * the timer are two pieces of evidence about the same activity, not one hour fifty-five.
 * The registration fields live here, on the event, and deliberately do not write into
 * `time_segments` — reconciliation is a decision the end-of-day review will offer, not
 * something a sync quietly performs.
 *
 * **Authentication is per account, not per provider.** `auth_method` exists because how you
 * prove who you are changes — Apple documents account-based authorisation for supported
 * third-party calendar apps alongside app-specific passwords, and a Windows build will
 * likely start with the latter. That is a property of one account at one moment, not
 * something to bake into the provider.
 */
export const migration013: Migration = {
  id: 13,
  name: 'calendar',
  sql: /* sql */ `
    -- ------------------------------------------------------------- accounts
    CREATE TABLE calendar_accounts (
      id                 TEXT PRIMARY KEY,
      -- 'ics' is a subscribed link rather than a connected account. It is the only route
      -- that needs no permission from whoever runs the mailbox, which on a managed tenant
      -- is the difference between having your calendar here and not.
      provider           TEXT NOT NULL CHECK (provider IN ('outlook','icloud','ics')),
      -- How this account is authenticated *right now*. Not a property of the provider:
      -- the same provider may support several, and which one is in use can change.
      -- 'url' is the honest description of a subscription — the link is the credential.
      auth_method        TEXT NOT NULL DEFAULT 'oauth'
                         CHECK (auth_method IN ('oauth','app-password','url')),
      display_name       TEXT NOT NULL,
      -- The address or Apple ID the account belongs to; shown, never used as a key.
      account_identifier TEXT,
      status             TEXT NOT NULL DEFAULT 'disconnected'
                         CHECK (status IN ('connected','disconnected','error')),
      -- Graph delta link or CalDAV sync token: whatever the provider hands back to resume.
      sync_token         TEXT,
      last_sync_at       INTEGER,
      last_error         TEXT,
      created_at         INTEGER NOT NULL
    );

    -- ------------------------------------------------------------ calendars
    -- One account exposes several calendars, and they are not equal: a birthdays calendar
    -- should never reach the planner, and a work calendar can carry defaults strong enough
    -- that its events never need classifying by hand.
    CREATE TABLE calendars (
      id                      TEXT PRIMARY KEY,
      account_id              TEXT NOT NULL REFERENCES calendar_accounts(id) ON DELETE CASCADE,
      external_id             TEXT NOT NULL,
      name                    TEXT NOT NULL,
      color                   TEXT,
      -- Read events from it at all.
      selected                INTEGER NOT NULL DEFAULT 1,
      -- Whether this calendar accepts events Uurwerk creates.
      writable                INTEGER NOT NULL DEFAULT 0,
      default_area_id         TEXT REFERENCES areas(id) ON DELETE SET NULL,
      default_organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
      default_project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,
      default_work_type_id    TEXT REFERENCES work_types(id) ON DELETE SET NULL,
      -- Birthdays, holidays: visible if you like, but never treated as busy time.
      ignore_for_planning     INTEGER NOT NULL DEFAULT 0,
      UNIQUE (account_id, external_id)
    );

    -- --------------------------------------------------------------- events
    CREATE TABLE calendar_events (
      id               TEXT PRIMARY KEY,
      title            TEXT NOT NULL,
      description      TEXT,
      location         TEXT,
      starts_at        INTEGER NOT NULL,
      ends_at          INTEGER NOT NULL,
      all_day          INTEGER NOT NULL DEFAULT 0,

      -- An appointment, or a travel block belonging to one.
      event_kind       TEXT NOT NULL DEFAULT 'appointment'
                       CHECK (event_kind IN ('appointment','travel')),
      parent_event_id  TEXT REFERENCES calendar_events(id) ON DELETE CASCADE,
      travel_direction TEXT CHECK (travel_direction IN ('outbound','return')),
      -- Set once you move or resize a travel block yourself: after that the parent moving
      -- no longer drags it along, because your edit is the more recent decision.
      travel_detached  INTEGER NOT NULL DEFAULT 0,

      -- Recurrence is read in this version and expanded for display. A modified or
      -- cancelled occurrence is its own row pointing back at the series.
      recurrence_rule       TEXT,
      recurrence_master_id  TEXT REFERENCES calendar_events(id) ON DELETE CASCADE,
      original_starts_at    INTEGER,
      cancelled             INTEGER NOT NULL DEFAULT 0,

      organizer        TEXT,
      attendees        TEXT NOT NULL DEFAULT '[]',

      -- Where the event came from. 'ics' is kept distinct from 'outlook' even when the
      -- link happens to point at an Outlook calendar: what it can do differs, and a badge
      -- that says Outlook on something read-only would promise editing that cannot work.
      origin           TEXT NOT NULL DEFAULT 'uurwerk'
                       CHECK (origin IN ('uurwerk','outlook','icloud','ics')),

      -- Uurwerk's own layer, the same four axes everything else is classified by.
      area_id          TEXT REFERENCES areas(id) ON DELETE SET NULL,
      organization_id  TEXT REFERENCES organizations(id) ON DELETE SET NULL,
      project_id       TEXT REFERENCES projects(id) ON DELETE SET NULL,
      work_type_id     TEXT REFERENCES work_types(id) ON DELETE SET NULL,

      classification_status TEXT NOT NULL DEFAULT 'unclassified'
                            CHECK (classification_status IN
                              ('unclassified','suggested','confirmed','ignored')),
      -- 0–100, from the deterministic classifier. Only meaningful with 'suggested'.
      confidence            INTEGER,

      -- Whether this period blocks planning in the Week view and Plan Day.
      include_in_planning   INTEGER NOT NULL DEFAULT 1,

      -- ------------------------------------------------------ time accounting
      -- 'none'    the hour is not worked time at all
      -- 'calendar'  count the scheduled duration
      -- 'confirm'   ask afterwards what actually happened
      registration_mode     TEXT NOT NULL DEFAULT 'none'
                            CHECK (registration_mode IN ('none','calendar','confirm')),
      counts_as_worked      INTEGER NOT NULL DEFAULT 0,
      -- Set once you confirm what the hour really was; overrides the scheduled duration.
      confirmed_min         INTEGER,
      -- The tracked segment this event turned out to be. A link, never a merge: an hour in
      -- the calendar and 55 minutes on the timer are the same activity counted twice if
      -- anything ever adds them together.
      reconciled_segment_id TEXT REFERENCES time_segments(id) ON DELETE SET NULL,

      local_updated_at INTEGER NOT NULL,
      created_at       INTEGER NOT NULL,
      deleted_at       INTEGER
    );

    CREATE INDEX idx_calendar_events_start  ON calendar_events(starts_at);
    CREATE INDEX idx_calendar_events_parent ON calendar_events(parent_event_id);
    CREATE INDEX idx_calendar_events_master ON calendar_events(recurrence_master_id);
    CREATE INDEX idx_calendar_events_status ON calendar_events(classification_status);

    -- ---------------------------------------------------------------- links
    -- The same logical event, as each provider knows it. This table is what makes
    -- "Uurwerk created it, Outlook echoed it back" resolvable rather than a duplicate.
    CREATE TABLE calendar_event_links (
      id                  TEXT PRIMARY KEY,
      event_id            TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
      account_id          TEXT NOT NULL REFERENCES calendar_accounts(id) ON DELETE CASCADE,
      calendar_id         TEXT REFERENCES calendars(id) ON DELETE SET NULL,
      external_id         TEXT NOT NULL,
      -- Graph changeKey / CalDAV etag: cheap "did this change" without refetching.
      etag                TEXT,
      external_updated_at INTEGER,
      last_synced_at      INTEGER,
      sync_status         TEXT NOT NULL DEFAULT 'synced'
                          CHECK (sync_status IN
                            ('synced','local_changed','external_changed','conflict','deleted')),
      UNIQUE (account_id, external_id)
    );

    CREATE INDEX idx_calendar_links_event ON calendar_event_links(event_id);

    -- ---------------------------------------------------------------- rules
    -- What Uurwerk has learned. Local, inspectable, and deletable — no model, no upload.
    CREATE TABLE classification_rules (
      id              TEXT PRIMARY KEY,
      matcher         TEXT NOT NULL CHECK (matcher IN
                        ('title','location','attendee','organizer','calendar')),
      -- Stored lowercased; matching is substring, like the capture blocklist.
      pattern         TEXT NOT NULL,
      area_id         TEXT REFERENCES areas(id) ON DELETE SET NULL,
      organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
      project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,
      work_type_id    TEXT REFERENCES work_types(id) ON DELETE SET NULL,
      -- How often it has been confirmed. Confidence grows with use rather than being set.
      hits            INTEGER NOT NULL DEFAULT 1,
      source          TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user','derived')),
      last_used_at    INTEGER,
      created_at      INTEGER NOT NULL,
      archived        INTEGER NOT NULL DEFAULT 0,
      UNIQUE (matcher, pattern)
    );
  `,
  run(db) {
    // Travel is an activity like any other, so it is a work type rather than a flag —
    // which means travel hours show up in the statistics beside meetings and research.
    db.run(
      `INSERT OR IGNORE INTO work_types (id, slug, name, sort_order, archived)
       VALUES ('work-type-travel', 'travel', 'Travel', 90, 0)`
    )
  }
}
