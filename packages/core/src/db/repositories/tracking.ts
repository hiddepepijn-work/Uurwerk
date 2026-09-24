import type {
  Attribution,
  CompletionReason,
  TimeSegment,
  TrackingRun
} from '../../contract/types.js'
import { Db, fromDbBool, newId, toDbBool } from '../connection.js'
import { minutesBetween } from '../../util/time.js'

interface RunRow {
  id: string
  started_at: number
  ended_at: number | null
  note: string | null
}

interface SegmentRow {
  id: string
  tracking_run_id: string
  task_id: string | null
  task_title: string | null
  area_id: string | null
  area_name: string | null
  project_name: string | null
  plan_block_id: string | null
  started_at: number
  ended_at: number | null
  counts_as_stage_hours: number
  note: string | null
  completion_reason: CompletionReason | null
  auto_stopped: number
  attribution: Attribution
  attribution_group: string | null
}

const SELECT_SEGMENTS = /* sql */ `
  SELECT
    g.*,
    t.title AS task_title,
    a.name  AS area_name,
    p.name  AS project_name
  FROM time_segments g
  LEFT JOIN tasks t    ON t.id = g.task_id
  LEFT JOIN areas a    ON a.id = g.area_id
  LEFT JOIN projects p ON p.id = t.project_id
`

const mapSegment = (row: SegmentRow): TimeSegment => ({
  id: row.id,
  trackingRunId: row.tracking_run_id,
  taskId: row.task_id,
  taskTitle: row.task_title,
  areaId: row.area_id,
  areaName: row.area_name,
  projectName: row.project_name,
  planBlockId: row.plan_block_id,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  countsAsStageHours: fromDbBool(row.counts_as_stage_hours),
  note: row.note,
  completionReason: row.completion_reason,
  autoStopped: fromDbBool(row.auto_stopped),
  attribution: row.attribution,
  attributionGroup: row.attribution_group,
  durationMin: minutesBetween(row.started_at, row.ended_at ?? Date.now())
})

/**
 * Runs and segments.
 *
 * This layer only stores; the rules about switching, completing and idling live in the
 * tracking service. The one invariant enforced here is adjacency: closing a segment and
 * opening the next uses a single timestamp, so a run never contains a gap or an overlap
 * that the user did not actually take.
 */
export class TrackingRepo {
  constructor(private readonly db: Db) {}

  // -------------------------------------------------------------------- runs

  currentRun(): TrackingRun | null {
    const row = this.db.get<RunRow>(
      'SELECT * FROM tracking_runs WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1'
    )
    return row ? this.hydrate(row) : null
  }

  getRun(id: string): TrackingRun | null {
    const row = this.db.get<RunRow>('SELECT * FROM tracking_runs WHERE id = ?', [id])
    return row ? this.hydrate(row) : null
  }

  startRun(at = Date.now(), note?: string): TrackingRun {
    const id = newId()
    this.db.run('INSERT INTO tracking_runs (id, started_at, note) VALUES (?, ?, ?)', [
      id,
      at,
      note ?? null
    ])
    return this.getRun(id)!
  }

  endRun(id: string, at = Date.now()): TrackingRun {
    this.db.run('UPDATE tracking_runs SET ended_at = ? WHERE id = ?', [at, id])
    return this.getRun(id)!
  }

  /**
   * Deletes a run outright.
   *
   * Only ever used for a run nothing worked: the derived run behind a calendar event whose
   * hours have just been withdrawn. Segments cascade, but the caller is expected to have
   * emptied it first — a run with real segments in it is history, not scratch.
   */
  removeRun(id: string): void {
    this.db.run('DELETE FROM tracking_runs WHERE id = ?', [id])
  }

  runsInRange(startMs: number, endMs: number): TrackingRun[] {
    return this.db
      .all<RunRow>(
        `SELECT * FROM tracking_runs
         WHERE started_at < ? AND COALESCE(ended_at, ?) > ?
         ORDER BY started_at`,
        [endMs, Date.now(), startMs]
      )
      .map((row) => this.hydrate(row))
  }

  private hydrate(row: RunRow): TrackingRun {
    const segments = this.segmentsForRun(row.id)
    return {
      id: row.id,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      note: row.note,
      segments,
      durationMin: minutesBetween(row.started_at, row.ended_at ?? Date.now())
    }
  }

  // ---------------------------------------------------------------- segments

  currentSegment(): TimeSegment | null {
    const row = this.db.get<SegmentRow>(
      `${SELECT_SEGMENTS} WHERE g.ended_at IS NULL ORDER BY g.started_at DESC LIMIT 1`
    )
    return row ? mapSegment(row) : null
  }

  getSegment(id: string): TimeSegment | null {
    const row = this.db.get<SegmentRow>(`${SELECT_SEGMENTS} WHERE g.id = ?`, [id])
    return row ? mapSegment(row) : null
  }

  /**
   * Every segment still open, oldest first.
   *
   * There should only ever be one. More than one means a switch left a segment behind, and
   * because `currentSegment` only ever returns the newest, the older ones are invisible
   * while still counting toward every total. Startup repair uses this to find them.
   */
  openSegments(): TimeSegment[] {
    return this.db
      .all<SegmentRow>(`${SELECT_SEGMENTS} WHERE g.ended_at IS NULL ORDER BY g.started_at`)
      .map(mapSegment)
  }

  segmentsForRun(runId: string): TimeSegment[] {
    return this.db
      .all<SegmentRow>(`${SELECT_SEGMENTS} WHERE g.tracking_run_id = ? ORDER BY g.started_at`, [
        runId
      ])
      .map(mapSegment)
  }

  /** Overlap rather than containment, so a segment spanning midnight appears on both days. */
  segmentsInRange(startMs: number, endMs: number): TimeSegment[] {
    return this.db
      .all<SegmentRow>(
        `${SELECT_SEGMENTS}
         WHERE g.started_at < ? AND COALESCE(g.ended_at, ?) > ?
         ORDER BY g.started_at`,
        [endMs, Date.now(), startMs]
      )
      .map(mapSegment)
  }

  startSegment(input: {
    trackingRunId: string
    taskId: string | null
    areaId: string | null
    /** Snapshot of the area's rule, taken now and never recalculated. */
    countsAsStageHours: boolean
    planBlockId?: string | null
    at?: number
    /** Only the attribution service passes these; live tracking is always 'tracked'. */
    attribution?: Attribution
    attributionGroup?: string | null
    endedAt?: number | null
    completionReason?: CompletionReason | null
  }): TimeSegment {
    const id = newId()
    this.db.run(
      `INSERT INTO time_segments
         (id, tracking_run_id, task_id, area_id, plan_block_id, started_at, ended_at,
          counts_as_stage_hours, completion_reason, attribution, attribution_group)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.trackingRunId,
        input.taskId,
        input.areaId,
        input.planBlockId ?? null,
        input.at ?? Date.now(),
        input.endedAt ?? null,
        toDbBool(input.countsAsStageHours),
        input.completionReason ?? null,
        input.attribution ?? 'tracked',
        input.attributionGroup ?? null
      ]
    )
    return this.getSegment(id)!
  }

  endSegment(
    id: string,
    at = Date.now(),
    reason: CompletionReason = 'stopped',
    options: { note?: string; autoStopped?: boolean } = {}
  ): TimeSegment {
    const segment = this.getSegment(id)
    if (!segment) throw new Error(`Time segment not found: ${id}`)

    this.db.run(
      `UPDATE time_segments
       SET ended_at = ?, completion_reason = ?, note = COALESCE(?, note), auto_stopped = ?
       WHERE id = ?`,
      [
        Math.max(at, segment.startedAt),
        reason,
        options.note ?? null,
        toDbBool(options.autoStopped ?? false),
        id
      ]
    )
    return this.getSegment(id)!
  }

  updateSegment(
    id: string,
    patch: Partial<
      Pick<
        TimeSegment,
        | 'taskId'
        | 'areaId'
        | 'startedAt'
        | 'endedAt'
        | 'note'
        | 'countsAsStageHours'
        | 'attribution'
        | 'attributionGroup'
      >
    >
  ): TimeSegment {
    const current = this.getSegment(id)
    if (!current) throw new Error(`Time segment not found: ${id}`)

    const next = { ...current, ...patch }
    if (next.endedAt !== null && next.endedAt < next.startedAt) {
      throw new Error('A time segment cannot end before it starts.')
    }

    this.db.run(
      `UPDATE time_segments
       SET task_id = ?, area_id = ?, started_at = ?, ended_at = ?, note = ?,
           counts_as_stage_hours = ?, attribution = ?, attribution_group = ?
       WHERE id = ?`,
      [
        next.taskId,
        next.areaId,
        next.startedAt,
        next.endedAt,
        next.note,
        toDbBool(next.countsAsStageHours),
        next.attribution,
        next.attributionGroup,
        id
      ]
    )
    return this.getSegment(id)!
  }

  removeSegment(id: string): void {
    this.db.run('DELETE FROM time_segments WHERE id = ?', [id])
  }

  /**
   * Restretches a run over its segments.
   *
   * Editing a stretch moves the segments, and a run left at its old bounds would report a
   * working session that no longer matches the hours inside it. Nothing derives hours from
   * run bounds, but "how long have I been working" is read off them, so they cannot be left
   * to drift.
   */
  setRunSpan(id: string, startedAt: number, endedAt: number | null): void {
    this.db.run('UPDATE tracking_runs SET started_at = ?, ended_at = ? WHERE id = ?', [
      startedAt,
      endedAt,
      id
    ])
  }

  /**
   * Closed, task-less segments overlapping the range — the raw material of the end-of-day
   * split.
   *
   * The open one is excluded on purpose: it is still being worked, its length is not yet
   * known, and cutting it into slices would end the run. Attributing a day you are still
   * inside divides what is finished and leaves the live stretch for the next pass.
   *
   * Selected by where the segment *starts*, not by overlap — the one place in this repo
   * that does. A stretch running past midnight belongs to exactly one day's attribution,
   * because splitting it from both sides would let tonight's percentages silently rewrite
   * last night's.
   *
   * 'manual' is excluded, and that exclusion is the guard on hand-entered hours: they are an
   * answer already given, not untasked time waiting for one.
   */
  unattributedInRange(startMs: number, endMs: number): TimeSegment[] {
    return this.db
      .all<SegmentRow>(
        `${SELECT_SEGMENTS}
         WHERE g.task_id IS NULL
           AND g.ended_at IS NOT NULL
           AND g.attribution = 'tracked'
           AND g.started_at >= ? AND g.started_at < ?
         ORDER BY g.started_at`,
        [startMs, endMs]
      )
      .map(mapSegment)
  }

  /**
   * Group ids of the split stretches that began inside the range, of one kind.
   *
   * The kind is required rather than optional: every caller has a definite answer to "whose
   * divisions am I about to rewrite", and a default here would let one of them not say.
   */
  attributionGroupsInRange(
    startMs: number,
    endMs: number,
    attribution: Attribution
  ): string[] {
    return this.db
      .all<{ attribution_group: string }>(
        `SELECT DISTINCT attribution_group FROM time_segments
         WHERE attribution_group IS NOT NULL
           AND attribution = ?
           AND started_at >= ? AND started_at < ?`,
        [attribution, startMs, endMs]
      )
      .map((row) => row.attribution_group)
  }

  /** Every slice cut from one stretch, anchor first. */
  segmentsInGroup(groupId: string): TimeSegment[] {
    return this.db
      .all<SegmentRow>(
        `${SELECT_SEGMENTS} WHERE g.attribution_group = ? ORDER BY g.started_at`,
        [groupId]
      )
      .map(mapSegment)
  }

}
