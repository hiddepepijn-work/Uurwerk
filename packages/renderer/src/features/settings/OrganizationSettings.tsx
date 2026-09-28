import { useState } from 'react'
import type { Organization, WorkType } from '@core/contract/types.js'
import { SYSTEM_ORGANIZATIONS } from '@core/contract/types.js'
import { api } from '../../api/client.js'
import {
  SettingsCard,
  SettingsSection,
  addButton,
  archiveButton,
  problemNote,
  textField
} from './SettingsSection.js'

const BUILT_IN: string[] = Object.values(SYSTEM_ORGANIZATIONS)

/**
 * Who you work for, and what kind of work it is.
 *
 * Neither of these decides whether time counts toward your internship — that is the area,
 * set per project and per task. They are here so the same employer can appear on internship
 * work and on work that is not, and so "research" is one thing rather than three.
 */
export function OrganizationSettings({
  organizations,
  workTypes,
  onChanged
}: {
  organizations: Organization[]
  workTypes: WorkType[]
  onChanged: () => void
}) {
  const [organizationName, setOrganizationName] = useState('')
  const [workTypeName, setWorkTypeName] = useState('')
  const [problem, setProblem] = useState<string | null>(null)

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setProblem(null)
    try {
      await action()
      onChanged()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    }
  }

  const addOrganization = async (): Promise<void> => {
    if (!organizationName.trim()) return
    await run(async () => {
      await api.organizations.create({ name: organizationName.trim() })
      setOrganizationName('')
    })
  }

  const addWorkType = async (): Promise<void> => {
    if (!workTypeName.trim()) return
    await run(async () => {
      await api.workTypes.create({ name: workTypeName.trim() })
      setWorkTypeName('')
    })
  }

  const input = `${textField} min-w-0 flex-1`
  const row = 'flex items-center gap-2.5 border-t border-border px-4 py-2.5 wide:px-5'

  return (
    <SettingsSection
      title="Organizations and work types"
      description="Who the work is for, and what kind of work it is. Both are independent of the area: the same organization can host internship work and work that is not, and one work type is reused across all of them."
    >
      {problem && <div className={problemNote}>{problem}</div>}

      <div className="grid grid-cols-1 gap-2.5 wide:grid-cols-2">
        <SettingsCard className="flex flex-col">
          <header className="label-caps px-4 pt-3.5 pb-1.5 wide:px-5">Organizations</header>

          {organizations.map((organization) => (
            <div key={organization.id} className={row}>
              <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-text">
                {organization.name}
              </span>
              <span className="shrink-0 font-code text-[12px] font-semibold text-text-faint">
                {organization.slug}
              </span>
              {!BUILT_IN.includes(organization.id) && (
                <button
                  onClick={() => void run(() => api.organizations.archive(organization.id))}
                  title="Archive"
                  className={archiveButton}
                >
                  ✕
                </button>
              )}
            </div>
          ))}

          <div className="mt-auto flex items-center gap-2 border-t border-border px-4 pt-3 pb-3.5 wide:px-5">
            <input
              value={organizationName}
              onChange={(event) => setOrganizationName(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && void addOrganization()}
              placeholder="Add an organization"
              className={input}
            />
            <button
              onClick={() => void addOrganization()}
              disabled={!organizationName.trim()}
              className={addButton}
            >
              Add
            </button>
          </div>
        </SettingsCard>

        <SettingsCard className="flex flex-col">
          <header className="label-caps px-4 pt-3.5 pb-1.5 wide:px-5">Work types</header>

          <div className="max-h-56 overflow-y-auto">
            {workTypes.map((workType) => (
              <div key={workType.id} className={row}>
                <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-text">
                  {workType.name}
                </span>
                <button
                  onClick={() => void run(() => api.workTypes.archive(workType.id))}
                  title="Archive — tasks already labelled with it keep their label"
                  className={archiveButton}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          <div className="mt-auto flex items-center gap-2 border-t border-border px-4 pt-3 pb-3.5 wide:px-5">
            <input
              value={workTypeName}
              onChange={(event) => setWorkTypeName(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && void addWorkType()}
              placeholder="Add a work type"
              className={input}
            />
            <button
              onClick={() => void addWorkType()}
              disabled={!workTypeName.trim()}
              className={addButton}
            >
              Add
            </button>
          </div>
        </SettingsCard>
      </div>
    </SettingsSection>
  )
}
