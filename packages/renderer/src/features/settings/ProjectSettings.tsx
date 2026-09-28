import { useState } from 'react'
import type { Area, Organization, Project } from '@core/contract/types.js'
import { api } from '../../api/client.js'
import { Button } from '../../ui/Button.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { FolderIcon, PlusIcon } from '../../ui/icons.js'
import { SettingsCard, SettingsSection, rowSelect, selectField } from './SettingsSection.js'

/** Muted Inkt tones: school blue, teal, amber, work purple, clay, stage green. */
const COLORS = ['#7F9FD6', '#5E9E97', '#D1A55A', '#A997CF', '#CC6F62', '#5DAE86']

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

  const field = `${selectField} h-11 w-full min-w-0 px-3 font-medium`
  /** On a phone the two selects share a second line under the name; wide, they sit inline. */
  const rowSelectInList = `${rowSelect} order-last min-w-0 flex-1 basis-[calc(50%-6px)] wide:order-none wide:flex-none wide:basis-auto`

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
        <SettingsCard className="flex flex-col gap-3 p-4 wide:p-5">
          <label className="flex flex-col gap-1.5">
            <span className="text-[14px] font-semibold text-text">Name</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && void create()}
              placeholder="SDSS De Margriet"
              className={field}
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[14px] font-semibold text-text">Organization</span>
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

            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[14px] font-semibold text-text">Area</span>
              <select value={areaId} onChange={(e) => setAreaId(e.target.value)} className={field}>
                {areas.map((area) => (
                  <option key={area.id} value={area.id}>
                    {area.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-[14px] font-semibold text-text">Colour</span>
            <div className="flex flex-wrap gap-2.5">
              {COLORS.map((option) => (
                <button
                  key={option}
                  onClick={() => setColor(option)}
                  aria-label={option}
                  style={{ background: option }}
                  className={`h-9 w-9 rounded-full transition-all ${
                    color === option ? 'ring-2 ring-text ring-offset-2 ring-offset-card' : ''
                  }`}
                />
              ))}
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreating(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void create()} disabled={busy || !name.trim()}>
              Create
            </Button>
          </div>
        </SettingsCard>
      )}

      {projects.length === 0 && !creating ? (
        <SettingsCard>
          <EmptyState
            icon={<FolderIcon size={24} />}
            title="No projects yet."
            hint="Tasks work fine without one, but a project keeps the weekly report readable."
          />
        </SettingsCard>
      ) : (
        <SettingsCard>
          {projects.map((project) => {
            const area = areaById.get(project.areaId ?? '') ?? null
            const areaAllowsSharing = area?.defaultShareSupervisor ?? false

            return (
              <div
                key={project.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-2.5 border-t border-border px-4 py-3.5 first:border-t-0 wide:flex-nowrap wide:px-5"
              >
                <span
                  className="h-3 w-3 shrink-0 rounded-full shadow-[inset_0_0_0_1px_rgb(255_255_255/0.12)]"
                  style={{ background: project.color }}
                />
                <span className="min-w-0 flex-1 truncate text-[16px] font-bold text-text">{project.name}</span>

                {/* Who it is for. Changing this never changes what the hours count as —
                    that is the area beside it, and past segments keep their own record. */}
                <select
                  value={project.organizationId ?? ''}
                  onChange={(event) =>
                    void update(project, { organizationId: event.target.value || null })
                  }
                  title="Who this work is for. It does not decide whether the hours count toward your internship."
                  className={rowSelectInList}
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
                  className={rowSelectInList}
                >
                  {areas.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </select>

                <label
                  className={`flex items-center gap-2 text-[13px] font-semibold ${
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
                    className="h-[18px] w-[18px] accent-accent disabled:opacity-40"
                  />
                  Shareable
                </label>
              </div>
            )
          })}
        </SettingsCard>
      )}
    </SettingsSection>
  )
}
