import { useState } from 'react'
import type { Area, Organization, Project } from '@core/contract/types.js'
import { api } from '../../api/client.js'
import { Button } from '../../ui/Button.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { FolderIcon, PlusIcon } from '../../ui/icons.js'
import { SettingsSection } from './SettingsSection.js'

const COLORS = ['#1B3A5C', '#14493F', '#4A3A1C', '#3B2A4A', '#4A1C1C', '#22C55E']

/**
 * Projects, and the three things about them that matter beyond the name: who the work is
 * for, which area it counts as, and whether it may be shared.
 *
 * Organization and area are set separately and never imply each other. The same employer
 * can appear on an internship project and on one that is ordinary paid work; picking the
 * organization says nothing about whether the hours count toward the internship.
 *
 * Sharing needs BOTH the area and the project to allow it. A project inside Work or
 * Personal cannot be shared however this switch is set — the area is the hard boundary,
 * and the row says so rather than letting you set a flag that does nothing.
 */
export function ProjectSettings({
  projects,
  areas,
  organizations,
  onChanged
}: {
  projects: Project[]
  areas: Area[]
  organizations: Organization[]
  onChanged: () => void
}) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [areaId, setAreaId] = useState(areas[0]?.id ?? 'stage')
  const [organizationId, setOrganizationId] = useState('')
  const [color, setColor] = useState(COLORS[0]!)
  const [busy, setBusy] = useState(false)

  const areaById = new Map(areas.map((area) => [area.id, area]))

  const create = async (): Promise<void> => {
    if (!name.trim()) return
    setBusy(true)
    try {
      await api.projects.create({
        name: name.trim(),
        areaId,
        organizationId: organizationId || null,
        color,
        shareable: false
      })
      setName('')
      setCreating(false)
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  const update = async (project: Project, patch: Partial<Project>): Promise<void> => {
    await api.projects.update(project.id, patch)
    onChanged()
  }

  const field =
    'rounded-[8px] border border-border bg-bg px-3 py-2 text-[14px] text-text outline-none focus:border-accent'

  return (
    <SettingsSection
      title="Projects"
      description="Group your tasks. A project belongs to one area, which decides whether its hours count toward your internship and whether it can be shared at all."
      action={
        !creating && (
          <Button
            variant="secondary"
            size="sm"
            icon={<PlusIcon size={14} />}
            onClick={() => setCreating(true)}
          >
            New project
          </Button>
        )
      }
    >
      {creating && (
        <div className="mb-5 flex flex-wrap items-end gap-3 rounded-[12px] border border-border bg-bg p-4">
          <label className="flex min-w-[220px] flex-1 flex-col gap-1.5">
            <span className="text-[12px] text-text-dim">Name</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && void create()}
              placeholder="SDSS De Margriet"
              className={field}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] text-text-dim">Organization</span>
            <select
              value={organizationId}
              onChange={(e) => setOrganizationId(e.target.value)}
              className={field}
            >
              <option value="">No organization</option>
              {organizations.map((organization) => (
                <option key={organization.id} value={organization.id}>
                  {organization.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] text-text-dim">Area</span>
            <select value={areaId} onChange={(e) => setAreaId(e.target.value)} className={field}>
              {areas.map((area) => (
                <option key={area.id} value={area.id}>
                  {area.name}
                </option>
              ))}
            </select>
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] text-text-dim">Colour</span>
            <div className="flex gap-1.5 py-1.5">
              {COLORS.map((option) => (
                <button
                  key={option}
                  onClick={() => setColor(option)}
                  aria-label={option}
                  style={{ background: option }}
                  className={`h-6 w-6 rounded-full transition-all ${
                    color === option ? 'ring-2 ring-accent ring-offset-2 ring-offset-bg' : ''
                  }`}
                />
              ))}
            </div>
          </div>

          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setCreating(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void create()}
              disabled={busy || !name.trim()}
            >
              Create
            </Button>
          </div>
        </div>
      )}

      {projects.length === 0 && !creating ? (
        <EmptyState
          icon={<FolderIcon size={24} />}
          title="No projects yet."
          hint="Tasks work fine without one, but a project keeps the weekly report readable."
        />
      ) : (
        <div className="overflow-hidden rounded-[12px] border border-border">
          {projects.map((project) => {
            const area = areaById.get(project.areaId ?? '') ?? null
            const areaAllowsSharing = area?.defaultShareSupervisor ?? false

            return (
              <div
                key={project.id}
                className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-b-0"
              >
                <span
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{ background: project.color }}
                />
                <span className="min-w-0 flex-1 truncate text-[14px] text-text">{project.name}</span>

                {/* Who it is for. Changing this never changes what the hours count as —
                    that is the area beside it, and past segments keep their own record. */}
                <select
                  value={project.organizationId ?? ''}
                  onChange={(event) =>
                    void update(project, { organizationId: event.target.value || null })
                  }
                  title="Who this work is for. It does not decide whether the hours count toward your internship."
                  className="rounded-[8px] border border-border bg-bg px-2.5 py-1.5 text-[13px] text-text-dim outline-none focus:border-accent"
                >
                  <option value="">No organization</option>
                  {organizations.map((organization) => (
                    <option key={organization.id} value={organization.id}>
                      {organization.name}
                    </option>
                  ))}
                </select>

                <select
                  value={project.areaId ?? ''}
                  onChange={(event) => void update(project, { areaId: event.target.value })}
                  className="rounded-[8px] border border-border bg-bg px-2.5 py-1.5 text-[13px] text-text-dim outline-none focus:border-accent"
                >
                  {areas.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </select>

                <label
                  className={`flex items-center gap-2 text-[13px] ${
                    areaAllowsSharing ? 'text-text-dim' : 'text-text-faint'
                  }`}
                  title={
                    areaAllowsSharing
                      ? 'Visible to your supervisor once a day is published.'
                      : `${area?.name ?? 'This area'} never shares, so this cannot be turned on.`
                  }
                >
                  <input
                    type="checkbox"
                    checked={project.shareable && areaAllowsSharing}
                    disabled={!areaAllowsSharing}
                    onChange={(event) => void update(project, { shareable: event.target.checked })}
                    className="accent-accent disabled:opacity-40"
                  />
                  Shareable
                </label>
              </div>
            )
          })}
        </div>
      )}
    </SettingsSection>
  )
}
