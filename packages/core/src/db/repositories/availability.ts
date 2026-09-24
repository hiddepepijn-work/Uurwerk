import type {
  Availability,
  FixedEvent,
  FixedEventKind,
  IsoDate,
  IsoWeek,
  PlanningProfile
} from '../../contract/types.js'
import { Db, fromDbBool, newId, toDbBool } from '../connection.js'

interface AvailabilityRow {
  id: string
  week: string | null
  weekday: number
  start_min: number
  end_min: number
  allowed_areas: string
  area_targets: string
  enabled: number
  stage_start_min: number | null
  stage_end_min: number | null
}

interface FixedEventRow {
  id: string
  date: string
  start_min: number
  end_min: number
  title: string
  kind: FixedEventKind
  area_id: string | null
  recurring: number
}

interface ProfileRow {
  id: string
  name: string
  buffer_percentage: number
  minimum_block_min: number
  preferred_block_min: number
  maximum_block_min: number
  discovery_block_min: number
  is_default: number
}

/** A corrupt JSON column must never take the planner down; fall back to "no constraint". */
function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

const mapAvailability = (row: AvailabilityRow): Availability => ({
  id: row.id,
  week: row.week,
  weekday: row.weekday,
  startMin: row.start_min,
  endMin: row.end_min,
  allowedAreas: parseJson<string[]>(row.allowed_areas, []),
  areaTargets: parseJson<Record<string, number>>(row.area_targets, {}),
  enabled: fromDbBool(row.enabled),
  stageStartMin: row.stage_start_min,
  stageEndMin: row.stage_end_min
})

const mapEvent = (row: FixedEventRow): FixedEvent => ({
  id: row.id,
  date: row.date,
  startMin: row.start_min,
  endMin: row.end_min,
  title: row.title,
  kind: row.kind,
  areaId: row.area_id,
  recurring: fromDbBool(row.recurring)
})

const mapProfile = (row: ProfileRow): PlanningProfile => ({
  id: row.id,
  name: row.name,
  bufferPercentage: row.buffer_percentage,
  minimumBlockMin: row.minimum_block_min,
  preferredBlockMin: row.preferred_block_min,
  maximumBlockMin: row.maximum_block_min,
  discoveryBlockMin: row.discovery_block_min,
  isDefault: fromDbBool(row.is_default)
})

/**
 * When work can happen at all: the daily windows, and the meetings and breaks carved out
 * of them. The planner asks this before it asks anything about priorities — a perfectly
 * ranked task that has nowhere to go is not a plan.
 */
export class AvailabilityRepo {
  constructor(private readonly db: Db) {}

  /**
   * The pattern for a week: its own overrides where they exist, the recurring default
   * everywhere else. A week the user never customised still returns a usable pattern.
   */
  forWeek(week: IsoWeek): Availability[] {
    const overrides = this.db
      .all<AvailabilityRow>('SELECT * FROM availability WHERE week = ? ORDER BY weekday', [week])
      .map(mapAvailability)

    const covered = new Set(overrides.map((row) => row.weekday))
    const defaults = this.db
      .all<AvailabilityRow>('SELECT * FROM availability WHERE week IS NULL ORDER BY weekday')
      .map(mapAvailability)
      .filter((row) => !covered.has(row.weekday))

    return [...overrides, ...defaults].sort((a, b) => a.weekday - b.weekday)
  }

  defaults(): Availability[] {
    return this.db
      .all<AvailabilityRow>('SELECT * FROM availability WHERE week IS NULL ORDER BY weekday')
      .map(mapAvailability)
  }

  upsert(input: Omit<Availability, 'id'> & { id?: string }): Availability {
    const existing = this.db.get<{ id: string }>(
      'SELECT id FROM availability WHERE weekday = ? AND week IS ?',
      [input.weekday, input.week]
    )
    const id = input.id ?? existing?.id ?? newId()

    this.db.run(
      `INSERT INTO availability
         (id, week, weekday, start_min, end_min, allowed_areas, area_targets, enabled,
          stage_start_min, stage_end_min)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         start_min = excluded.start_min,
         end_min = excluded.end_min,
         allowed_areas = excluded.allowed_areas,
         area_targets = excluded.area_targets,
         enabled = excluded.enabled,
         stage_start_min = excluded.stage_start_min,
         stage_end_min = excluded.stage_end_min`,
      [
        id,
        input.week,
        input.weekday,
        input.startMin,
        input.endMin,
        JSON.stringify(input.allowedAreas),
        JSON.stringify(input.areaTargets),
        toDbBool(input.enabled),
        input.stageStartMin,
        input.stageEndMin
      ]
    )

    return mapAvailability(
      this.db.get<AvailabilityRow>('SELECT * FROM availability WHERE id = ?', [id])!
    )
  }

  // ------------------------------------------------------------ fixed events

  eventsBetween(from: IsoDate, to: IsoDate): FixedEvent[] {
    return this.db
      .all<FixedEventRow>(
        'SELECT * FROM fixed_events WHERE date BETWEEN ? AND ? ORDER BY date, start_min',
        [from, to]
      )
      .map(mapEvent)
  }

  eventsOn(date: IsoDate): FixedEvent[] {
    return this.eventsBetween(date, date)
  }

  addEvent(input: Omit<FixedEvent, 'id'>): FixedEvent {
    if (input.endMin <= input.startMin) throw new Error('An event must end after it starts.')

    const id = newId()
    this.db.run(
      `INSERT INTO fixed_events (id, date, start_min, end_min, title, kind, area_id, recurring)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.date,
        input.startMin,
        input.endMin,
        input.title.trim(),
        input.kind,
        input.areaId,
        toDbBool(input.recurring)
      ]
    )
    return mapEvent(this.db.get<FixedEventRow>('SELECT * FROM fixed_events WHERE id = ?', [id])!)
  }

  removeEvent(id: string): void {
    this.db.run('DELETE FROM fixed_events WHERE id = ?', [id])
  }

  // -------------------------------------------------------- planning profile

  profile(id = 'balanced'): PlanningProfile | null {
    const row = this.db.get<ProfileRow>('SELECT * FROM planning_profiles WHERE id = ?', [id])
    return row ? mapProfile(row) : null
  }

  defaultProfile(): PlanningProfile {
    const row = this.db.get<ProfileRow>(
      'SELECT * FROM planning_profiles WHERE is_default = 1 LIMIT 1'
    )
    if (row) return mapProfile(row)

    // Migration 004 seeds this; the fallback keeps the planner usable if it is ever missing.
    return {
      id: 'balanced',
      name: 'Balanced',
      bufferPercentage: 12,
      minimumBlockMin: 25,
      preferredBlockMin: 90,
      maximumBlockMin: 120,
      discoveryBlockMin: 60,
      isDefault: true
    }
  }

  saveProfile(profile: PlanningProfile): PlanningProfile {
    this.db.run(
      `INSERT INTO planning_profiles
         (id, name, buffer_percentage, minimum_block_min, preferred_block_min,
          maximum_block_min, discovery_block_min, is_default)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         buffer_percentage = excluded.buffer_percentage,
         minimum_block_min = excluded.minimum_block_min,
         preferred_block_min = excluded.preferred_block_min,
         maximum_block_min = excluded.maximum_block_min,
         discovery_block_min = excluded.discovery_block_min,
         is_default = excluded.is_default`,
      [
        profile.id,
        profile.name,
        profile.bufferPercentage,
        profile.minimumBlockMin,
        profile.preferredBlockMin,
        profile.maximumBlockMin,
        profile.discoveryBlockMin,
        toDbBool(profile.isDefault)
      ]
    )
    return profile
  }
}
