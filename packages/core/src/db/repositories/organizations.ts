import type { NewOrganization, Organization } from '../../contract/types.js'
import { SYSTEM_ORGANIZATIONS } from '../../contract/types.js'
import { Db, fromDbBool, newId } from '../connection.js'

interface OrganizationRow {
  id: string
  slug: string
  name: string
  archived: number
  created_at: number
}

const map = (row: OrganizationRow): Organization => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  archived: fromDbBool(row.archived),
  createdAt: row.created_at
})

/** Seeded organizations keep their ids; archiving them would strand the projects on them. */
const SYSTEM_IDS: string[] = Object.values(SYSTEM_ORGANIZATIONS)

/** `HAS Green Academy` → `has-green-academy`. */
export function toSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Who work is for.
 *
 * This repository knows nothing about areas, and that is the point: an organization can
 * host internship work, other paid work and nothing else at all, and no query here may
 * imply which. Classification lives on the task, in its area.
 */
export class OrganizationRepo {
  constructor(private readonly db: Db) {}

  list(includeArchived = false): Organization[] {
    const sql = includeArchived
      ? 'SELECT * FROM organizations ORDER BY name COLLATE NOCASE'
      : 'SELECT * FROM organizations WHERE archived = 0 ORDER BY name COLLATE NOCASE'
    return this.db.all<OrganizationRow>(sql).map(map)
  }

  get(id: string): Organization | null {
    const row = this.db.get<OrganizationRow>('SELECT * FROM organizations WHERE id = ?', [id])
    return row ? map(row) : null
  }

  bySlug(slug: string): Organization | null {
    const row = this.db.get<OrganizationRow>('SELECT * FROM organizations WHERE slug = ?', [slug])
    return row ? map(row) : null
  }

  /** Convenience for the callers that resolve many ids at once. */
  byId(): Map<string, Organization> {
    return new Map(this.list(true).map((organization) => [organization.id, organization]))
  }

  create(input: NewOrganization): Organization {
    const name = input.name.trim()
    if (!name) throw new Error('An organization needs a name.')

    const slug = input.slug?.trim() || toSlug(name)
    if (!slug) throw new Error(`"${name}" does not produce a usable slug; give one explicitly.`)

    const existing = this.bySlug(slug)
    if (existing) {
      throw new Error(`An organization with the slug "${slug}" already exists: ${existing.name}.`)
    }

    const id = input.id ?? newId()
    this.db.run(
      `INSERT INTO organizations (id, slug, name, archived, created_at) VALUES (?, ?, ?, 0, ?)`,
      [id, slug, name, Date.now()]
    )
    return this.get(id)!
  }

  update(id: string, patch: Partial<Pick<Organization, 'name' | 'slug' | 'archived'>>): Organization {
    const current = this.get(id)
    if (!current) throw new Error(`Organization not found: ${id}`)

    const next = { ...current, ...patch }
    this.db.run('UPDATE organizations SET name = ?, slug = ?, archived = ? WHERE id = ?', [
      next.name.trim(),
      next.slug.trim(),
      next.archived ? 1 : 0,
      id
    ])
    return this.get(id)!
  }

  archive(id: string): void {
    if (SYSTEM_IDS.includes(id)) {
      throw new Error('Maasarend and HAS Green Academy are built in and cannot be removed.')
    }
    this.db.run('UPDATE organizations SET archived = 1 WHERE id = ?', [id])
  }
}
