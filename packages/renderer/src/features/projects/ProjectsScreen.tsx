import { useEffect, useState } from 'react'
import type { ProjectOverview, ProjectTaskRow, TaskReadiness } from '@core/contract/types.js'
import { toIsoDate } from '@core/util/time.js'
import { useLiveQuery } from '../../hooks/useLiveQuery.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { StatCard } from '../../ui/StatCard.js'
import { ProgressBar } from '../../ui/ProgressBar.js'
import { PriorityDot } from '../../ui/PriorityDot.js'
import { BarChartIcon, CalendarIcon, ChecklistIcon, ClockIcon } from '../../ui/icons.js'
import { formatDuration } from '../../lib/format.js'

/**
 * One project, in the order the work has to happen.
 *
 * The Tasks screen sorts by priority, which is the right answer to "what matters most" and
 * cannot express that seven of eight chapters are unstartable. A chain appears there as
 * eight equally available tasks; the dependency edges hold the truth and nothing showed it.
 *
 * So this is the same tasks read the other way round: dependency order, each row saying what
 * it waits for and what waits on it, and when it is actually scheduled. Deliberately a list
 * rather than a graph — the ordering is the insight, and a list of nine rows stays readable
 * where a diagram of nine nodes is already fighting for space.
 */
export function ProjectsScreen() {
  const { data: projects } = useLiveQuery((client) => client.projects.list(), ['settings'], [])
  const [projectId, setProjectId] = useState<string | null>(null)

  // The first project is almost always the one you want, and an empty screen behind a
  // dropdown you have to discover is a screen nobody opens twice.
  useEffect(() => {
    if (!projectId && projects && projects.length > 0) setProjectId(projects[0]!.id)
  }, [projects, projectId])

  const { data: overview, error } = useLiveQuery(
    (client) =>
      projectId
        ? client.projects.overview(projectId)
        : Promise.resolve(null as ProjectOverview | null),
    ['tasks', 'planning', 'sessions', 'settings'],
    [projectId]
  )

  if (projects && projects.length === 0) {
    return (
      <div className="p-8">
        <h1 className="text-[32px] leading-tight font-semibold">Projects</h1>
        <div className="mt-8">
          <EmptyState
            icon={<ChecklistIcon size={26} />}
            title="No projects yet."
            hint="Add one under Settings, then give its tasks a project to see them ordered here."
          />
        </div>
      </div>
    )
  }

  const done = overview ? overview.doneCount : 0
  const total = overview ? overview.taskCount : 0

  return (
    <div className="p-8">
      <header className="mb-7 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[32px] leading-tight font-semibold">Projects</h1>
          <p className="mt-1 text-[14px] text-text-dim">
            What is where, what you can pick up now, and when each piece is meant to happen.
          </p>
        </div>

        <select
          value={projectId ?? ''}
          onChange={(event) => setProjectId(event.target.value || null)}
          className="rounded-[10px] border border-border bg-card px-3.5 py-2.5 text-[14px] text-text outline-none focus:border-accent"
        >
          {(projects ?? []).map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </header>

      {error && (
        <div className="mb-6 rounded-[10px] border border-prio-med/40 bg-prio-med/10 px-4 py-3 text-[13px] text-prio-med">
          {error}
        </div>
      )}

      {overview && (
        <>
          <div className="mb-3 flex items-center gap-2 text-[13px] text-text-dim">
            {overview.areaName && (
              <span className="rounded-[6px] border border-border px-2 py-0.5">
                {overview.areaName}
              </span>
            )}
            {overview.organizationName && <span>{overview.organizationName}</span>}
          </div>

          <div className="mb-7 grid grid-cols-4 gap-4">
            <StatCard
              icon={<ChecklistIcon size={16} />}
              label="Done"
              value={`${done} / ${total}`}
              sub={total > 0 ? `${Math.round((done / total) * 100)}% of the tasks` : 'nothing yet'}
              progress={{ value: done, max: Math.max(1, total) }}
            />
            <StatCard
              icon={<ClockIcon size={16} />}
              label="Time left"
              value={formatDuration(overview.remainingMin)}
              sub={`${formatDuration(overview.loggedMin)} logged of ${formatDuration(overview.estimateMin)}`}
            />
            <StatCard
              icon={<CalendarIcon size={16} />}
              label="Last deadline"
              value={overview.finalDueDate ? shortDate(overview.finalDueDate) : '—'}
              sub={
                overview.overdueCount > 0
                  ? `${overview.overdueCount} already overdue`
                  : 'nothing overdue'
              }
            />
            <StatCard
              icon={<BarChartIcon size={16} />}
              label="Not scheduled"
              value={String(overview.unplannedCount)}
              sub={
                overview.unplannedCount === 0
                  ? 'every task has time set aside'
                  : 'tasks with no hours reserved'
              }
            />
          </div>

          <ProgressBar value={done} max={Math.max(1, total)} />

          <div className="mt-7 overflow-hidden rounded-[12px] border border-border">
            <table className="w-full text-[13px]">
              <thead className="bg-bg text-text-dim">
                <tr>
                  <th className="w-10 px-3 py-2.5 text-right font-medium">#</th>
                  <th className="px-4 py-2.5 text-left font-medium">Task</th>
                  <th className="px-4 py-2.5 text-left font-medium">State</th>
                  <th className="px-4 py-2.5 text-left font-medium">Planned</th>
                  <th className="px-4 py-2.5 text-left font-medium">Due</th>
                  <th className="px-4 py-2.5 text-right font-medium">Time</th>
                </tr>
              </thead>
              <tbody>
                {overview.tasks.map((row) => (
                  <Row
                    key={row.taskId}
                    row={row}
                    isNext={row.taskId === overview.nextTaskId}
                    today={toIsoDate(Date.now())}
                  />
                ))}
              </tbody>
            </table>

            {overview.tasks.length === 0 && (
              <p className="px-4 py-8 text-center text-[13px] text-text-faint">
                This project has no tasks yet.
              </p>
            )}
          </div>

          <p className="mt-4 text-[12px] leading-relaxed text-text-faint">
            Ordered so nothing appears before the work it depends on.{' '}
            <span className="text-accent">Ready</span> means every prerequisite is finished and you
            could start it now. <span className="text-text-dim">Planned</span> comes from the day
            plans you accepted — a task with no dates is work nobody has found the hours for.
          </p>
        </>
      )}
    </div>
  )
}

const STATE_STYLE: Record<TaskReadiness, string> = {
  done: 'border-border text-text-faint',
  ready: 'border-accent/40 bg-accent/10 text-accent',
  waiting: 'border-block-blue/50 text-text-dim',
  blocked: 'border-prio-high/40 bg-prio-high/10 text-prio-high'
}

function Row({
  row,
  isNext,
  today
}: {
  row: ProjectTaskRow
  isNext: boolean
  today: string
}) {
  const overdue = row.readiness !== 'done' && row.dueDate !== null && row.dueDate < today
  const spent = row.estimateMin !== null && row.estimateMin > 0

  return (
    <tr className={`border-t border-border ${isNext ? 'bg-rail-active' : ''}`}>
      <td className="px-3 py-3 text-right font-mono text-text-faint tabular-nums">{row.order}</td>

      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <PriorityDot priority={row.priority} />
          <span className={row.readiness === 'done' ? 'text-text-faint line-through' : 'text-text'}>
            {row.title}
          </span>
          {isNext && (
            <span className="rounded-[5px] bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-[#06210F]">
              NEXT
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 text-[12px] text-text-faint">
          {row.workTypeName && <span>{row.workTypeName}</span>}
          {row.blocks.length > 0 && (
            <span title={row.blocks.map((entry) => entry.title).join('\n')}>
              blocks {row.blocks.map((entry) => `#${entry.order}`).join(' ')}
            </span>
          )}
        </div>
      </td>

      <td className="px-4 py-3">
        <span
          className={`inline-block rounded-[6px] border px-2 py-0.5 text-[12px] ${STATE_STYLE[row.readiness]}`}
        >
          {label(row)}
        </span>
      </td>

      <td className="px-4 py-3 text-text-dim">
        {row.plannedFrom ? (
          <span className="whitespace-nowrap">
            {shortDate(row.plannedFrom)}
            {row.plannedTo && row.plannedTo !== row.plannedFrom && ` – ${shortDate(row.plannedTo)}`}
          </span>
        ) : row.readiness === 'done' ? (
          <span className="text-text-faint">—</span>
        ) : (
          <span className="text-text-faint">not scheduled</span>
        )}
      </td>

      <td className={`px-4 py-3 whitespace-nowrap ${overdue ? 'text-prio-high' : 'text-text-dim'}`}>
        {row.dueDate ? shortDate(row.dueDate) : '—'}
      </td>

      <td className="px-4 py-3 text-right font-mono text-text-dim tabular-nums">
        {spent ? (
          <span title={`${row.loggedMin} of ${row.estimateMin} minutes`}>
            {formatDuration(row.loggedMin)}
            <span className="text-text-faint"> / {formatDuration(row.estimateMin ?? 0)}</span>
          </span>
        ) : row.loggedMin > 0 ? (
          formatDuration(row.loggedMin)
        ) : (
          <span className="text-text-faint">—</span>
        )}
      </td>
    </tr>
  )
}

/** What the state pill says, and for a waiting row, what it is waiting for. */
function label(row: ProjectTaskRow): string {
  if (row.readiness === 'done') return 'done'
  if (row.readiness === 'blocked') return row.blockedReason ? `blocked: ${row.blockedReason}` : 'blocked'
  if (row.readiness === 'ready') return 'ready now'
  // Naming the one thing it waits for is more use than a count; beyond that a count is
  // all that fits, and the full list is a hover away on the row itself.
  const [first, ...rest] = row.waitingOn
  if (!first) return 'waiting'
  return rest.length === 0
    ? `waits for #${first.order}`
    : `waits for #${first.order} +${rest.length}`
}

/** '28 Aug' — enough to place a date in the current year at a glance. */
const shortDate = (date: string): string =>
  new Date(`${date}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
