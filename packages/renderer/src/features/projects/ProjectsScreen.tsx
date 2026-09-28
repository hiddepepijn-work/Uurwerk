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
import { colorFor } from '../agenda/agenda-model.js'

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
      <div className="px-4 pt-4 pb-6 wide:px-8 wide:py-7">
        <h1 className="display-title text-[34px] wide:text-[40px]">Projects</h1>
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
  const area = overview ? colorFor(overview.project.areaId) : null

  return (
    <div className="px-4 pt-4 pb-6 wide:px-8 wide:py-7">
      <header className="mb-4 flex flex-col gap-4 wide:mb-5 wide:flex-row wide:items-end wide:justify-between">
        <div className="min-w-0">
          <h1 className="display-title text-[34px] wide:text-[40px]">Projects</h1>
          <p className="mt-1.5 text-[14px] leading-snug font-medium text-text-dim wide:text-[15px] wide:font-normal">
            What is where, what you can pick up now, and when each piece is meant to happen.
          </p>
        </div>

        <label className="flex shrink-0 flex-col gap-1.5">
          <span className="label-caps tracking-[0.8px]">Project</span>
          <span className="relative block">
            <select
              value={projectId ?? ''}
              onChange={(event) => setProjectId(event.target.value || null)}
              className="h-12 w-full appearance-none rounded-button bg-input pr-11 pl-3.5 text-[16px] font-bold text-text outline-none wide:h-11 wide:w-[260px] wide:rounded-input wide:text-[15px]"
            >
              {(projects ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="pointer-events-none absolute top-1/2 right-3.5 -translate-y-1/2 text-text-dim"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </span>
        </label>
      </header>

      {error && (
        <div className="mb-5 rounded-input bg-warn-soft px-4 py-3 text-[13px] font-semibold text-warn">
          {error}
        </div>
      )}

      {overview && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2 text-[13px] font-bold">
            {overview.areaName && area && (
              <span
                className="rounded-pill px-3 py-[5px]"
                style={{
                  background: area.tint,
                  color: area.soft,
                  boxShadow: `inset 0 0 0 1.5px ${area.fill}`
                }}
              >
                {overview.areaName}
              </span>
            )}
            {overview.organizationName && (
              <span className="rounded-pill bg-input px-3 py-[5px] text-text-dim">
                {overview.organizationName}
              </span>
            )}
          </div>

          <div className="mb-4 grid grid-cols-2 gap-2.5 wide:grid-cols-4 wide:gap-3">
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

          <ProgressBar value={done} max={Math.max(1, total)} className="h-2 rounded-[4px]" />

          {/* A table on the desktop; on the phone each row stacks, with planned / due / time
              in a small grid underneath. Same elements either way, only the layout classes
              differ (the phone wrappers become `display: contents` on wide). */}
          <div role="table" className="mt-4 overflow-hidden rounded-[22px] bg-card wide:p-2">
            <div role="rowgroup">
              <div
                role="row"
                className="flex justify-between gap-3 border-b border-border px-4 pt-3.5 pb-2.5 wide:hidden"
              >
                <span className="label-caps tracking-[0.8px]"># · Task · State</span>
                <span className="label-caps tracking-[0.8px]">Planned · Due · Time</span>
              </div>
              <div
                role="row"
                className={`label-caps hidden tracking-[0.8px] wide:grid wide:px-3.5 wide:py-2.5 ${ROW_GRID}`}
              >
                <span role="columnheader">#</span>
                <span role="columnheader">Task</span>
                <span role="columnheader">State</span>
                <span role="columnheader">Planned</span>
                <span role="columnheader">Due</span>
                <span role="columnheader" className="text-right">
                  Time
                </span>
              </div>
            </div>
            <div role="rowgroup">
              {overview.tasks.map((row, index) => (
                <Row
                  key={row.taskId}
                  row={row}
                  isNext={row.taskId === overview.nextTaskId}
                  first={index === 0}
                  today={toIsoDate(Date.now())}
                />
              ))}
            </div>

            {overview.tasks.length === 0 && (
              <p className="px-4 py-8 text-center text-[13px] text-text-faint">
                This project has no tasks yet.
              </p>
            )}
          </div>

          <p className="mt-4 max-w-[900px] text-[13px] leading-normal font-medium text-text-faint">
            Ordered so nothing appears before the work it depends on.{' '}
            <span className="font-bold text-accent-soft">Ready</span> means every prerequisite is
            finished and you could start it now.{' '}
            <span className="font-bold text-text-dim">Planned</span> comes from the day
            plans you accepted — a task with no dates is work nobody has found the hours for.
          </p>
        </>
      )}
    </div>
  )
}

/** The desktop column template; the phone ignores it and stacks the row instead. */
const ROW_GRID = 'wide:grid-cols-[44px_minmax(0,1fr)_190px_170px_90px_100px] wide:gap-3'

const STATE_STYLE: Record<TaskReadiness, string> = {
  done: 'bg-input text-text-faint',
  ready: 'bg-area-stage-tint text-area-stage-soft',
  waiting:
    'bg-area-school-tint text-area-school-soft shadow-[inset_0_0_0_1.5px_var(--color-area-school)]',
  blocked: 'bg-danger-soft text-danger-text'
}

/** A cell's own column name, shown only when the phone stacks the row. */
function CellLabel({ children }: { children: string }) {
  return <span className="label-caps text-[11px] tracking-[0.6px] wide:hidden">{children}</span>
}

function Row({
  row,
  isNext,
  first,
  today
}: {
  row: ProjectTaskRow
  isNext: boolean
  first: boolean
  today: string
}) {
  const overdue = row.readiness !== 'done' && row.dueDate !== null && row.dueDate < today
  const spent = row.estimateMin !== null && row.estimateMin > 0

  return (
    <div
      role="row"
      className={`flex gap-3 border-b border-border px-4 py-3.5 last:border-b-0 wide:grid wide:items-center wide:rounded-button wide:border-b-0 wide:px-3.5 wide:py-[11px] ${ROW_GRID} ${
        isNext ? 'bg-rail-active' : ''
      } ${first || isNext ? '' : 'wide:border-t wide:border-border'}`}
    >
      <span
        role="cell"
        className="w-[22px] shrink-0 pt-px text-[14px] font-bold text-text-faint tabular-nums wide:w-auto wide:pt-0"
      >
        {row.order}
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-2 wide:contents">
        <div role="cell" className="flex min-w-0 flex-col gap-[3px]">
          <div className="flex items-center gap-2">
            <PriorityDot priority={row.priority} />
            <span
              className={`text-[16px] leading-tight font-bold wide:text-[15px] ${
                row.readiness === 'done' ? 'text-text-faint line-through' : 'text-text'
              }`}
            >
              {row.title}
            </span>
            {isNext && (
              <span className="shrink-0 rounded-pill bg-accent px-2 py-0.5 text-[11px] font-bold tracking-[0.6px] text-accent-ink">
                NEXT
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-x-3 pl-4 text-[13px] font-medium text-text-dim wide:font-normal wide:text-text-faint">
            {row.workTypeName && <span>{row.workTypeName}</span>}
            {row.blocks.length > 0 && (
              <span title={row.blocks.map((entry) => entry.title).join('\n')}>
                blocks {row.blocks.map((entry) => `#${entry.order}`).join(' ')}
              </span>
            )}
          </div>
        </div>

        <div role="cell" className="pl-4 wide:pl-0">
          <span
            className={`inline-block rounded-pill px-[11px] py-1 text-[13px] font-bold wide:px-2.5 wide:text-[12px] ${STATE_STYLE[row.readiness]}`}
          >
            {label(row)}
          </span>
        </div>

        <div className="grid grid-cols-[1.5fr_0.8fr_0.8fr] gap-2 pl-4 wide:contents">
          <div
            role="cell"
            className="flex flex-col gap-0.5 text-[13px] font-semibold text-text tabular-nums wide:text-[14px] wide:font-normal wide:text-text-dim"
          >
            <CellLabel>Planned</CellLabel>
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
          </div>

          <div
            role="cell"
            className={`flex flex-col gap-0.5 text-[13px] font-semibold whitespace-nowrap tabular-nums wide:text-[14px] ${
              overdue ? 'text-danger-text' : 'text-text wide:text-text-dim'
            }`}
          >
            <CellLabel>Due</CellLabel>
            <span>{row.dueDate ? shortDate(row.dueDate) : '—'}</span>
          </div>

          <div
            role="cell"
            className="flex flex-col gap-0.5 text-[13px] font-semibold text-text tabular-nums wide:items-end wide:text-[14px] wide:font-bold wide:text-text-dim"
          >
            <CellLabel>Time</CellLabel>
            {spent ? (
              <span title={`${row.loggedMin} of ${row.estimateMin} minutes`}>
                {formatDuration(row.loggedMin)}
                <span className="text-text-faint"> / {formatDuration(row.estimateMin ?? 0)}</span>
              </span>
            ) : row.loggedMin > 0 ? (
              <span>{formatDuration(row.loggedMin)}</span>
            ) : (
              <span className="text-text-faint">—</span>
            )}
          </div>
        </div>
      </div>
    </div>
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
