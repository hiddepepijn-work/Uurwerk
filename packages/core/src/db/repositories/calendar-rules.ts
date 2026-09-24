import type { ClassificationRule, RuleMatcher } from '../../contract/types.js'
import { Db, newId } from '../connection.js'

interface RuleRow {
  id: string
  matcher: RuleMatcher
  pattern: string
  area_id: string | null
  organization_id: string | null
  project_id: string | null
  work_type_id: string | null
  hits: number
  source: 'user' | 'derived'
  last_used_at: number | null
  archived: number
}

const map = (row: RuleRow): ClassificationRule => ({
  id: row.id,
  matcher: row.matcher,
  pattern: row.pattern,
  areaId: row.area_id,
  organizationId: row.organization_id,
  projectId: row.project_id,
  workTypeId: row.work_type_id,
  hits: row.hits,
  source: row.source,
  lastUsedAt: row.last_used_at
})

/**
 * What Uurwerk has learned about classifying appointments.
 *
 * Rules, not a model: every one of them is a row you can read, argue with and delete, and
 * none of it leaves the machine. Confidence comes from how often a rule has been confirmed,
 * so the app gets surer the more you agree with it and no surer than that.
 */
export class ClassificationRuleRepo {
  constructor(private readonly db: Db) {}

  list(includeArchived = false): ClassificationRule[] {
    const sql = includeArchived
      ? 'SELECT * FROM classification_rules ORDER BY hits DESC, pattern'
      : 'SELECT * FROM classification_rules WHERE archived = 0 ORDER BY hits DESC, pattern'
    return this.db.all<RuleRow>(sql).map(map)
  }

  get(id: string): ClassificationRule | null {
    const row = this.db.get<RuleRow>('SELECT * FROM classification_rules WHERE id = ?', [id])
    return row ? map(row) : null
  }

  /**
   * Records a rule, or strengthens one that already says the same thing.
   *
   * Confirming the same classification twice raises `hits` rather than adding a second row:
   * agreement is evidence, not duplication. A rule that now points somewhere else is
   * overwritten — your latest correction is what you meant.
   */
  learn(input: {
    matcher: RuleMatcher
    pattern: string
    areaId?: string | null
    organizationId?: string | null
    projectId?: string | null
    workTypeId?: string | null
    source?: 'user' | 'derived'
  }): ClassificationRule {
    const pattern = input.pattern.trim().toLowerCase()
    if (!pattern) throw new Error('A classification rule needs something to match on.')

    const existing = this.db.get<RuleRow>(
      'SELECT * FROM classification_rules WHERE matcher = ? AND pattern = ?',
      [input.matcher, pattern]
    )

    if (existing) {
      const sameAnswer =
        existing.area_id === (input.areaId ?? null) &&
        existing.organization_id === (input.organizationId ?? null) &&
        existing.project_id === (input.projectId ?? null) &&
        existing.work_type_id === (input.workTypeId ?? null)

      this.db.run(
        `UPDATE classification_rules SET
           area_id = ?, organization_id = ?, project_id = ?, work_type_id = ?,
           hits = ?, last_used_at = ?, archived = 0
         WHERE id = ?`,
        [
          input.areaId ?? null,
          input.organizationId ?? null,
          input.projectId ?? null,
          input.workTypeId ?? null,
          // Disagreeing with yourself resets the count: the old confidence was earned by a
          // different answer and should not be inherited by the new one.
          sameAnswer ? existing.hits + 1 : 1,
          Date.now(),
          existing.id
        ]
      )
      return this.get(existing.id)!
    }

    const id = newId()
    this.db.run(
      `INSERT INTO classification_rules
         (id, matcher, pattern, area_id, organization_id, project_id, work_type_id,
          hits, source, last_used_at, created_at, archived)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 0)`,
      [
        id,
        input.matcher,
        pattern,
        input.areaId ?? null,
        input.organizationId ?? null,
        input.projectId ?? null,
        input.workTypeId ?? null,
        input.source ?? 'user',
        Date.now(),
        Date.now()
      ]
    )
    return this.get(id)!
  }

  /** Forgetting is a feature: a rule you no longer agree with should stop being applied. */
  forget(id: string): void {
    this.db.run('UPDATE classification_rules SET archived = 1 WHERE id = ?', [id])
  }

  markUsed(ids: string[]): void {
    if (ids.length === 0) return
    this.db.transaction(() => {
      for (const id of ids) {
        this.db.run('UPDATE classification_rules SET last_used_at = ? WHERE id = ?', [
          Date.now(),
          id
        ])
      }
    })
  }
}
