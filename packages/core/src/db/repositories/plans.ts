import type {
  BlockKind,
  BlockSource,
  IsoDate,
  NewPlanBlock,
  PendingDraft,
  Plan,
  PlanBlock,
  PlanIntensity,
  PlanScope,
  PlanStatus
} from '../../contract/types.js'
import { Db, fromDbBool, newId, toDbBool } from '../connection.js'

interface PlanRow {
  id: string
  scope: PlanScope
  period_key: string
  version: number
  parent_plan_id: string | null
  status: PlanStatus
  reason: string | null
  intensity: PlanIntensity
  created_at: number
  accepted_at: number | null
}

interface BlockRow {
  id: string
  plan_id: string
  task_id: string | null
  task_title: string | null
  area_id: string | null
  project_name: string | null
  project_color: string | null
  date: string
  start_min: number
  end_min: number
  kind: BlockKind
  title: string | null
  fixed: number
  locked: number
  source: BlockSource
  original_block_id: string | null
  explanation: string | null
  score: number | null
}

const mapPlan = (row: PlanRow): Plan => ({
  id: row.id,
  scope: row.scope,
  periodKey: row.period_key,
  version: row.version,
  parentPlanId: row.parent_plan_id,
  status: row.status,
  reason: row.reason,
  intensity: row.intensity,
  createdAt: row.created_at,
  acceptedAt: row.accepted_at
})

const mapBlock = (row: BlockRow): PlanBlock => ({
  id: row.id,
  planId: row.plan_id,
  taskId: row.task_id,
  taskTitle: row.task_title,
  areaId: row.area_id,
  projectName: row.project_name,
  projectColor: row.project_color,
  date: row.date,
  startMin: row.start_min,
  endMin: row.end_min,
  kind: row.kind,
  title: row.title,
  fixed: fromDbBool(row.fixed),
  locked: fromDbBool(row.locked),
  source: row.source,
  originalBlockId: row.original_block_id,
  explanation: row.explanation,
  score: row.score
})

const SELECT_BLOCKS = /* sql */ `
  SELECT
    b.*,
    t.title AS task_title,
    p.name  AS project_name,
    p.color AS project_color
  FROM plan_blocks b
  LEFT JOIN tasks t    ON t.id = b.task_id
  LEFT JOIN projects p ON p.id = t.project_id
`

/**
 * Plans are versioned documents.
 *
 * Nothing in here edits an accepted plan in place. A revision is a new row whose
 * parentPlanId points at the plan it replaces, and accepting it supersedes the old one in
 * a single transaction. That is what keeps the baseline — the first accepted plan for a
 * period — reachable for reporting no matter how often the week is replanned.
 */
export class PlanRepo {
  constructor(private readonly db: Db) {}

  get(id: string): Plan | null {
    const row = this.db.get<PlanRow>('SELECT * FROM plans WHERE id = ?', [id])
    return row ? mapPlan(row) : null
  }

  /** The plan currently in force for a period, if the user has accepted one. */
  accepted(scope: PlanScope, periodKey: string): Plan | null {
    const row = this.db.get<PlanRow>(
      `SELECT * FROM plans
       WHERE scope = ? AND period_key = ? AND status = 'accepted'
       ORDER BY version DESC LIMIT 1`,
      [scope, periodKey]
    )
    return row ? mapPlan(row) : null
  }

  /**
   * The first plan ever accepted for this period. Reports compare against this, so it must
   * survive every later revision — hence 'superseded' rather than deletion.
   */
  baseline(scope: PlanScope, periodKey: string): Plan | null {
    const row = this.db.get<PlanRow>(
      `SELECT * FROM plans
       WHERE scope = ? AND period_key = ? AND accepted_at IS NOT NULL
       ORDER BY version ASC LIMIT 1`,
      [scope, periodKey]
    )
    return row ? mapPlan(row) : null
  }

  /** Every revision for a period, oldest first — the plan history. */
  history(scope: PlanScope, periodKey: string): Plan[] {
    return this.db
      .all<PlanRow>('SELECT * FROM plans WHERE scope = ? AND period_key = ? ORDER BY version', [
        scope,
        periodKey
      ])
      .map(mapPlan)
  }

  /** The open draft for a period, if reanalysis has already prepared one. */
  draft(scope: PlanScope, periodKey: string): Plan | null {
    const row = this.db.get<PlanRow>(
      `SELECT * FROM plans
       WHERE scope = ? AND period_key = ? AND status = 'draft'
       ORDER BY created_at DESC LIMIT 1`,
      [scope, periodKey]
    )
    return row ? mapPlan(row) : null
  }

  createDraft(input: {
    scope: PlanScope
    periodKey: string
    parentPlanId?: string | null
    reason?: string
    intensity?: PlanIntensity
  }): Plan {
    const id = newId()
    const parent = input.parentPlanId ?? this.accepted(input.scope, input.periodKey)?.id ?? null
    const version =
      (this.db.get<{ n: number | null }>(
        'SELECT MAX(version) AS n FROM plans WHERE scope = ? AND period_key = ?',
        [input.scope, input.periodKey]
      )?.n ?? 0) + 1

    this.db.run(
      `INSERT INTO plans
         (id, scope, period_key, version, parent_plan_id, status, reason, intensity,
          created_at, accepted_at)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, NULL)`,
      [
        id,
        input.scope,
        input.periodKey,
        version,
        parent,
        input.reason ?? null,
        input.intensity ?? 'balanced',
        Date.now()
      ]
    )
    return this.get(id)!
  }

  /**
   * Drafts with something in them, and what accepting each one would do.
   *
   * A draft is invisible everywhere else in the app: every reader of a plan takes the
   * accepted version, so work left in a draft counts toward nothing and says nothing about
   * it. This is what lets the UI point at that instead of leaving it stranded.
   *
   * An inner join rather than a left one, on purpose: an empty draft is what closing the
   * day planner without touching anything leaves behind, and offering to accept a plan with
   * nothing in it would be noise.
   */
  pendingDrafts(): PendingDraft[] {
    const rows = this.db.all<{
      id: string
      scope: PlanScope
      period_key: string
      created_at: number
      block_count: number
      planned_min: number
    }>(/* sql */ `
      SELECT
        p.id, p.scope, p.period_key, p.created_at,
        COUNT(b.id) AS block_count,
        COALESCE(SUM(CASE WHEN b.kind = 'task' THEN b.end_min - b.start_min ELSE 0 END), 0)
          AS planned_min
      FROM plans p
      JOIN plan_blocks b ON b.plan_id = p.id
      WHERE p.status = 'draft'
      GROUP BY p.id
      ORDER BY p.period_key
    `)

    return rows.map((row) => ({
      planId: row.id,
      scope: row.scope,
      periodKey: row.period_key,
      blockCount: row.block_count,
      plannedMin: row.planned_min,
      // Worth saying out loud in the UI: this one is a revision, not a first plan.
      replacesAccepted: this.accepted(row.scope, row.period_key) !== null,
      createdAt: row.created_at
    }))
  }

  /**
   * Promotes a draft to accepted and supersedes whatever it replaces, in one transaction.
   * A period can never have two accepted plans, not even for an instant.
   */
  accept(planId: string): Plan {
    const plan = this.get(planId)
    if (!plan) throw new Error(`Plan not found: ${planId}`)
    if (plan.status === 'accepted') return plan

    return this.db.transaction(() => {
      this.db.run(
        `UPDATE plans SET status = 'superseded'
         WHERE scope = ? AND period_key = ? AND status = 'accepted'`,
        [plan.scope, plan.periodKey]
      )
      this.db.run("UPDATE plans SET status = 'accepted', accepted_at = ? WHERE id = ?", [
        Date.now(),
        planId
      ])
      return this.get(planId)!
    })
  }

  /**
   * Leaves a period with no plan in force.
   *
   * Discarding a draft only throws away the working copy — the plan it was branched from is
   * still what the week reads, so a day you wanted rid of goes on looking planned however
   * many times you press it. Superseding it with an empty plan is how the versioned model
   * says "nothing here": the day reads as unplanned, and the baseline stays reachable so a
   * report can still show what you had originally intended.
   *
   * Deleting the accepted row instead would be the obvious move and the wrong one. It is
   * history, and reports compare against it.
   */
  clearPeriod(scope: PlanScope, periodKey: string): Plan | null {
    return this.db.transaction(() => {
      if (!this.accepted(scope, periodKey)) {
        // Nothing in force. An open draft is the only thing that could be making this day
        // look planned to its own editor, so that is what goes.
        const draft = this.draft(scope, periodKey)
        if (draft) this.discardDraft(draft.id)
        return null
      }

      // Any working copy goes with it. Leaving it behind would strand a draft for a day
      // that was just emptied, and it would reappear as planning waiting to be accepted.
      const open = this.draft(scope, periodKey)
      if (open) this.discardDraft(open.id)

      const empty = this.createDraft({ scope, periodKey, reason: 'Cleared' })
      return this.accept(empty.id)
    })
  }

  discardDraft(planId: string): void {
    const plan = this.get(planId)
    if (plan?.status !== 'draft') {
      throw new Error('Only a draft can be discarded; accepted plans are kept as history.')
    }
    this.db.run('DELETE FROM plans WHERE id = ?', [planId])
  }

  // ------------------------------------------------------------------ blocks

  blocks(planId: string): PlanBlock[] {
    return this.db
      .all<BlockRow>(`${SELECT_BLOCKS} WHERE b.plan_id = ? ORDER BY b.date, b.start_min`, [planId])
      .map(mapBlock)
  }

  blocksOnDate(planId: string, date: IsoDate): PlanBlock[] {
    return this.db
      .all<BlockRow>(
        `${SELECT_BLOCKS} WHERE b.plan_id = ? AND b.date = ? ORDER BY b.start_min`,
        [planId, date]
      )
      .map(mapBlock)
  }

  getBlock(id: string): PlanBlock | null {
    const row = this.db.get<BlockRow>(`${SELECT_BLOCKS} WHERE b.id = ?`, [id])
    return row ? mapBlock(row) : null
  }

  addBlock(planId: string, input: NewPlanBlock): PlanBlock {
    if (input.endMin <= input.startMin) {
      throw new Error('A plan block must end after it starts.')
    }
    const id = newId()
    this.db.run(
      `INSERT INTO plan_blocks
         (id, plan_id, task_id, area_id, date, start_min, end_min, kind, title,
          fixed, locked, source, original_block_id, explanation, score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        planId,
        input.taskId ?? null,
        input.areaId ?? null,
        input.date,
        input.startMin,
        input.endMin,
        input.kind ?? 'task',
        input.title ?? null,
        toDbBool(input.fixed ?? false),
        toDbBool(input.locked ?? false),
        input.source ?? 'planner',
        input.originalBlockId ?? null,
        input.explanation ?? null,
        input.score ?? null
      ]
    )
    return this.getBlock(id)!
  }

  updateBlock(id: string, patch: Partial<NewPlanBlock>): PlanBlock {
    const current = this.getBlock(id)
    if (!current) throw new Error(`Plan block not found: ${id}`)

    const next = { ...current, ...patch }
    if (next.endMin <= next.startMin) throw new Error('A plan block must end after it starts.')

    this.db.run(
      `UPDATE plan_blocks SET
         task_id = ?, area_id = ?, date = ?, start_min = ?, end_min = ?, kind = ?,
         title = ?, fixed = ?, locked = ?, source = ?, explanation = ?, score = ?
       WHERE id = ?`,
      [
        next.taskId ?? null,
        next.areaId ?? null,
        next.date,
        next.startMin,
        next.endMin,
        next.kind ?? 'task',
        next.title ?? null,
        toDbBool(next.fixed ?? false),
        toDbBool(next.locked ?? false),
        next.source ?? 'planner',
        next.explanation ?? null,
        next.score ?? null,
        id
      ]
    )
    return this.getBlock(id)!
  }

  removeBlock(id: string): void {
    this.db.run('DELETE FROM plan_blocks WHERE id = ?', [id])
  }

  /**
   * Copies every block of one plan onto another, recording where each came from.
   * The originalBlockId chain is what lets a diff report "moved" instead of
   * "one block disappeared and an unrelated one appeared".
   */
  copyBlocks(fromPlanId: string, toPlanId: string): PlanBlock[] {
    return this.db.transaction(() =>
      this.blocks(fromPlanId).map((block) =>
        this.addBlock(toPlanId, {
          taskId: block.taskId,
          areaId: block.areaId,
          date: block.date,
          startMin: block.startMin,
          endMin: block.endMin,
          kind: block.kind,
          title: block.title,
          fixed: block.fixed,
          locked: block.locked,
          source: block.source,
          originalBlockId: block.originalBlockId ?? block.id,
          explanation: block.explanation,
          score: block.score
        })
      )
    )
  }

  /**
   * Blocks from the accepted plan of each given day.
   *
   * A week is planned one day at a time, so the week view has to gather them rather than
   * read a single week plan — and it must take only the *accepted* version of each day,
   * never a draft someone left open.
   */
  acceptedBlocksForDays(days: IsoDate[]): PlanBlock[] {
    const out: PlanBlock[] = []
    for (const date of days) {
      const plan = this.accepted('day', date)
      if (plan) out.push(...this.blocks(plan.id))
    }
    return out.sort((a, b) => (a.date === b.date ? a.startMin - b.startMin : a.date < b.date ? -1 : 1))
  }

  /**
   * When each task is actually scheduled, across every accepted plan.
   *
   * The other planned-minutes readers answer "how much"; this answers "when", which is the
   * only form of the question a project overview can act on. Accepted plans only — a draft
   * is not a commitment to a date.
   */
  plannedSpanByTask(): Map<string, { from: IsoDate; to: IsoDate; minutes: number }> {
    const rows = this.db.all<{
      task_id: string
      from_date: string
      to_date: string
      minutes: number
    }>(/* sql */ `
      SELECT
        b.task_id,
        MIN(b.date) AS from_date,
        MAX(b.date) AS to_date,
        SUM(b.end_min - b.start_min) AS minutes
      FROM plan_blocks b
      JOIN plans p ON p.id = b.plan_id
      WHERE p.status = 'accepted' AND b.task_id IS NOT NULL AND b.kind = 'task'
      GROUP BY b.task_id
    `)

    return new Map(
      rows.map((row) => [row.task_id, { from: row.from_date, to: row.to_date, minutes: row.minutes }])
    )
  }

  /** Planned minutes per task across a set of days, from accepted day plans only. */
  plannedMinutesForDays(days: IsoDate[]): Map<string, number> {
    const totals = new Map<string, number>()
    for (const block of this.acceptedBlocksForDays(days)) {
      if (!block.taskId || block.kind !== 'task') continue
      totals.set(block.taskId, (totals.get(block.taskId) ?? 0) + (block.endMin - block.startMin))
    }
    return totals
  }

  /**
   * The same days, but from each day's *first* accepted plan.
   *
   * This is what makes the report honest about replanning. The current plan always matches
   * what happened reasonably well — you moved it there because that is how the day went.
   * The baseline is what you said on Monday, and the gap between the two is the part worth
   * explaining to a supervisor.
   */
  baselineBlocksForDays(days: IsoDate[]): PlanBlock[] {
    const out: PlanBlock[] = []
    for (const date of days) {
      const plan = this.baseline('day', date)
      if (plan) out.push(...this.blocks(plan.id))
    }
    return out.sort((a, b) => (a.date === b.date ? a.startMin - b.startMin : a.date < b.date ? -1 : 1))
  }

  /** Baseline minutes per task across a set of days. */
  baselineMinutesForDays(days: IsoDate[]): Map<string, number> {
    const totals = new Map<string, number>()
    for (const block of this.baselineBlocksForDays(days)) {
      if (!block.taskId || block.kind !== 'task') continue
      totals.set(block.taskId, (totals.get(block.taskId) ?? 0) + (block.endMin - block.startMin))
    }
    return totals
  }

  /** Planned minutes per task in the accepted plan for a period. */
  plannedMinutesByTask(scope: PlanScope, periodKey: string): Map<string, number> {
    const plan = this.accepted(scope, periodKey)
    if (!plan) return new Map()

    const rows = this.db.all<{ task_id: string; minutes: number }>(
      `SELECT task_id, SUM(end_min - start_min) AS minutes
       FROM plan_blocks
       WHERE plan_id = ? AND task_id IS NOT NULL AND kind = 'task'
       GROUP BY task_id`,
      [plan.id]
    )
    return new Map(rows.map((row) => [row.task_id, row.minutes]))
  }
}
