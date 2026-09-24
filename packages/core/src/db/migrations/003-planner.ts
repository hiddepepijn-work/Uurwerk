import type { Migration } from './index.js'

/**
 * The planner redesign schema.
 *
 * Five structural additions, each of which the old schema could not express:
 *
 *   areas            hour classification and sharing defaults above projects
 *   dependencies     hard and preferred ordering between tasks
 *   plans            versioned plan documents, so a revision never destroys the baseline
 *   tracking runs    one continuous run containing several task segments
 *   proposals        reanalysis output that waits for consent instead of mutating a plan
 *
 * Migrations 1 and 2 have already run on live databases and are frozen. Nothing here
 * alters an existing table's meaning; the old `sessions` and `planned` tables stay
 * readable until 004 has copied them forward.
 */
export const migration003: Migration = {
  id: 3,
  name: 'planner',
  sql: /* sql */ `
    -- ------------------------------------------------------------------ areas
    -- The hour classification lives here, but is COPIED onto each time segment when it
    -- starts. Moving a task to another area must never rewrite hours already logged.
    CREATE TABLE areas (
      id                        TEXT PRIMARY KEY,
      name                      TEXT NOT NULL,
      color                     TEXT NOT NULL DEFAULT '#1B3A5C',
      counts_as_stage_hours     INTEGER NOT NULL DEFAULT 0,
      default_share_supervisor  INTEGER NOT NULL DEFAULT 0,
      default_share_teacher     INTEGER NOT NULL DEFAULT 0,
      sort_order                INTEGER NOT NULL DEFAULT 0,
      archived                  INTEGER NOT NULL DEFAULT 0
    );

    ALTER TABLE projects ADD COLUMN area_id TEXT REFERENCES areas(id) ON DELETE SET NULL;

    -- ------------------------------------------------------------------ tasks
    -- estimate_min and due_date already exist and are already nullable — unknown stays
    -- unknown rather than becoming a zero or a fake deadline.
    ALTER TABLE tasks ADD COLUMN area_id             TEXT REFERENCES areas(id) ON DELETE SET NULL;
    ALTER TABLE tasks ADD COLUMN earliest_start_date TEXT;
    ALTER TABLE tasks ADD COLUMN postponed_count     INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE tasks ADD COLUMN blocked_reason      TEXT;
    ALTER TABLE tasks ADD COLUMN must_do_date        TEXT;

    CREATE INDEX idx_tasks_area ON tasks(area_id);

    -- SQLite cannot alter a CHECK constraint, so status widening ('in_progress',
    -- 'blocked') is enforced in the repository layer rather than by the column.

    -- ----------------------------------------------------------- dependencies
    CREATE TABLE task_dependencies (
      task_id            TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      type               TEXT NOT NULL DEFAULT 'hard' CHECK (type IN ('hard','preferred')),
      created_at         INTEGER NOT NULL,
      PRIMARY KEY (task_id, depends_on_task_id),
      -- A task depending on itself is the degenerate cycle; block it in the schema.
      CHECK (task_id <> depends_on_task_id)
    );
    CREATE INDEX idx_dependencies_depends_on ON task_dependencies(depends_on_task_id);

    -- ------------------------------------------------------ planning profiles
    CREATE TABLE planning_profiles (
      id                 TEXT PRIMARY KEY,
      name               TEXT NOT NULL,
      buffer_percentage  INTEGER NOT NULL DEFAULT 12,
      minimum_block_min  INTEGER NOT NULL DEFAULT 25,
      preferred_block_min INTEGER NOT NULL DEFAULT 90,
      maximum_block_min  INTEGER NOT NULL DEFAULT 120,
      discovery_block_min INTEGER NOT NULL DEFAULT 60,
      is_default         INTEGER NOT NULL DEFAULT 0
    );

    -- ------------------------------------------------------------- availability
    -- One row per weekday per profile: when work is expected to happen at all.
    CREATE TABLE availability (
      id            TEXT PRIMARY KEY,
      -- ISO week key, or NULL for the recurring default pattern.
      week          TEXT,
      -- 1 = Monday .. 7 = Sunday
      weekday       INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
      start_min     INTEGER NOT NULL,
      end_min       INTEGER NOT NULL,
      allowed_areas TEXT NOT NULL DEFAULT '[]',
      area_targets  TEXT NOT NULL DEFAULT '{}',
      enabled       INTEGER NOT NULL DEFAULT 1,
      CHECK (end_min > start_min)
    );
    CREATE INDEX idx_availability_week ON availability(week, weekday);

    -- Breaks, meetings and unavailable periods. Dated, because they are concrete.
    CREATE TABLE fixed_events (
      id        TEXT PRIMARY KEY,
      date      TEXT NOT NULL,
      start_min INTEGER NOT NULL,
      end_min   INTEGER NOT NULL,
      title     TEXT NOT NULL,
      kind      TEXT NOT NULL DEFAULT 'meeting'
                CHECK (kind IN ('meeting','break','unavailable')),
      area_id   TEXT REFERENCES areas(id) ON DELETE SET NULL,
      recurring INTEGER NOT NULL DEFAULT 0,
      CHECK (end_min > start_min)
    );
    CREATE INDEX idx_fixed_events_date ON fixed_events(date);

    -- ------------------------------------------------------------------ plans
    -- A plan is a document with a version chain. The first accepted plan of a period is
    -- its baseline and stays reachable through parent_plan_id forever — reports compare
    -- against it long after the plan has been revised.
    CREATE TABLE plans (
      id             TEXT PRIMARY KEY,
      scope          TEXT NOT NULL CHECK (scope IN ('day','week')),
      period_key     TEXT NOT NULL,           -- '2026-08-04' or '2026-W32'
      version        INTEGER NOT NULL DEFAULT 1,
      parent_plan_id TEXT REFERENCES plans(id) ON DELETE SET NULL,
      status         TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','accepted','superseded','completed')),
      reason         TEXT,
      intensity      TEXT NOT NULL DEFAULT 'balanced'
                     CHECK (intensity IN ('relaxed','balanced','full')),
      created_at     INTEGER NOT NULL,
      accepted_at    INTEGER
    );
    CREATE INDEX idx_plans_period ON plans(scope, period_key, status);

    -- Actual time is NEVER written here. Plan blocks are intent; time_segments are fact.
    CREATE TABLE plan_blocks (
      id                TEXT PRIMARY KEY,
      plan_id           TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      task_id           TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      area_id           TEXT REFERENCES areas(id) ON DELETE SET NULL,
      date              TEXT NOT NULL,
      start_min         INTEGER NOT NULL,
      end_min           INTEGER NOT NULL,
      kind              TEXT NOT NULL DEFAULT 'task'
                        CHECK (kind IN ('task','meeting','break','buffer')),
      title             TEXT,
      fixed             INTEGER NOT NULL DEFAULT 0,
      locked            INTEGER NOT NULL DEFAULT 0,
      source            TEXT NOT NULL DEFAULT 'planner'
                        CHECK (source IN ('manual','planner','imported')),
      -- Links a block to its ancestor in the baseline, so a diff can say "this moved"
      -- rather than "one block vanished and another appeared".
      original_block_id TEXT REFERENCES plan_blocks(id) ON DELETE SET NULL,
      explanation       TEXT,
      score             INTEGER,
      CHECK (end_min > start_min)
    );
    CREATE INDEX idx_plan_blocks_plan ON plan_blocks(plan_id, date);
    CREATE INDEX idx_plan_blocks_task ON plan_blocks(task_id);

    -- ---------------------------------------------------------------- tracking
    -- A run is one continuous stretch of working. It survives task switching.
    CREATE TABLE tracking_runs (
      id         TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      ended_at   INTEGER,
      note       TEXT
    );
    CREATE INDEX idx_runs_started ON tracking_runs(started_at);

    -- One segment per task within a run. Segments within a run are adjacent by
    -- construction: switching closes one and opens the next at the same instant.
    CREATE TABLE time_segments (
      id                    TEXT PRIMARY KEY,
      tracking_run_id       TEXT NOT NULL REFERENCES tracking_runs(id) ON DELETE CASCADE,
      task_id               TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      area_id               TEXT REFERENCES areas(id) ON DELETE SET NULL,
      plan_block_id         TEXT REFERENCES plan_blocks(id) ON DELETE SET NULL,
      started_at            INTEGER NOT NULL,
      ended_at              INTEGER,
      -- Snapshot of the area's rule at the moment work happened. Deliberately duplicated:
      -- reclassifying an area must not silently rewrite what was already reported.
      counts_as_stage_hours INTEGER NOT NULL DEFAULT 0,
      note                  TEXT,
      completion_reason     TEXT CHECK (completion_reason IN
                            ('switched','completed','blocked','break','stopped','idle')),
      auto_stopped          INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_segments_run     ON time_segments(tracking_run_id);
    CREATE INDEX idx_segments_started ON time_segments(started_at);
    CREATE INDEX idx_segments_task    ON time_segments(task_id);

    -- -------------------------------------------------------------- proposals
    -- Reanalysis writes here. It may build a complete draft plan, but the draft cannot
    -- become 'accepted' without an explicit user action.
    CREATE TABLE plan_update_proposals (
      id               TEXT PRIMARY KEY,
      base_plan_id     TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      proposed_plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      reason           TEXT NOT NULL,
      detail           TEXT NOT NULL DEFAULT '{}',
      status           TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','accepted','rejected','postponed')),
      created_at       INTEGER NOT NULL,
      resolved_at      INTEGER
    );
    CREATE INDEX idx_proposals_status ON plan_update_proposals(status, created_at);
  `
}
