import type { Migration } from './index.js'

/**
 * Organizations, and the School area.
 *
 * Until now "who the work is for" and "how it is classified" were the same field: a project
 * carried an area, and every project belonged to the internship. That collapses the moment
 * one organization hosts two kinds of work — Maasarend is both the internship and paid work
 * that is not the internship — and it has no room at all for a second organization.
 *
 * So they are split. An **organization** is who the work is for. An **area** is what the
 * work counts as. They are independent on purpose:
 *
 *   Maasarend + Stage   → internship hours, shared with the supervisor
 *   Maasarend + Work    → the same organization, not internship hours, private by default
 *   HAS Green Academy + School → education, shared with the teacher, never stage hours
 *
 * Nothing here classifies anything. Existing projects get `organization_id = NULL` rather
 * than a guess made from their name, and not one task or time segment is touched — deriving
 * an area from an organization is exactly the mistake this migration exists to make
 * impossible.
 */
export const migration009: Migration = {
  id: 9,
  name: 'organizations',
  sql: /* sql */ `
    CREATE TABLE organizations (
      id         TEXT PRIMARY KEY,
      -- Stable, lowercase, unique: what code and imports refer to when a name may change.
      slug       TEXT NOT NULL UNIQUE,
      name       TEXT NOT NULL,
      archived   INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    -- Nullable, and it stays nullable: a project without an organization is a real state,
    -- not an error, and forcing a value here would mean inventing one for existing rows.
    ALTER TABLE projects
      ADD COLUMN organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL;

    CREATE INDEX idx_projects_organization ON projects(organization_id);
  `,
  run(db) {
    const now = Date.now()

    // Fixed ids, like the areas in migration 004: settings, tests and imports refer to them
    // across installations.
    const organizations = [
      { id: 'organization-maasarend', slug: 'maasarend', name: 'Maasarend' },
      { id: 'organization-has-green-academy', slug: 'has-green-academy', name: 'HAS Green Academy' }
    ]

    for (const organization of organizations) {
      db.run(
        `INSERT OR IGNORE INTO organizations (id, slug, name, archived, created_at)
         VALUES (?, ?, ?, 0, ?)`,
        [organization.id, organization.slug, organization.name, now]
      )
    }

    /**
     * The fourth area.
     *
     * School is education at HAS Green Academy: it never counts toward internship hours,
     * the internship supervisor has no claim on it, and the teacher does. That last flag is
     * the only place in the seeded data where supervisor and teacher differ, which is the
     * whole reason they were kept as two independent booleans.
     */
    db.run(
      `INSERT OR IGNORE INTO areas
         (id, name, color, counts_as_stage_hours, default_share_supervisor,
          default_share_teacher, sort_order, archived)
       VALUES ('school', 'School', '#6D4AFF', 0, 0, 1, 3, 0)`
    )
  }
}
