import type { WeekReport } from '@core/contract/types.js'
import { formatDuration } from '../../lib/format.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { ClockIcon } from '../../ui/icons.js'

const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
  archived: 'Archived'
}

/** The status pill: area tints, so "done" is green and "blocked" reads as a problem. */
const STATUS_STYLE: Record<string, string> = {
  open: 'bg-input text-text-dim',
  in_progress: 'bg-area-school-tint text-area-school-soft',
  blocked: 'bg-danger-soft text-danger-text',
  done: 'bg-area-stage-tint text-area-stage-soft',
  archived: 'bg-input text-text-faint'
}

/**
 * The desktop column templates, with and without the "Original" column. The phone ignores
 * them: there each row stacks, with its numbers in a small grid underneath.
 */
const GRID_WITH_BASELINE =
  'wide:grid-cols-[minmax(0,2.4fr)_minmax(0,1.5fr)_100px_100px_100px_110px_130px]'
const GRID_WITHOUT_BASELINE =
  'wide:grid-cols-[minmax(0,2.4fr)_minmax(0,1.5fr)_100px_100px_110px_130px]'

/** A number cell's own column name, shown only when the phone stacks the row. */
function CellLabel({ children }: { children: string }) {
  return <span className="label-caps text-[11px] tracking-[0.6px] wide:hidden">{children}</span>
}

/**
 * The hours table, exactly as it will appear in the document.
 *
 * The "Original" column only shows up when the week was actually replanned, matching what
 * docx.ts does. A column repeating the number next to it teaches the reader to skip the
 * table, and this table is the one thing in the report that has to be read.
 */
export function HoursTable({ report }: { report: WeekReport }) {
  if (report.rows.length === 0) {
    return (
      <EmptyState
        icon={<ClockIcon size={26} />}
        title="Nothing tracked or planned this week."
        hint="The document would say the same, so there is nothing to send yet."
      />
    )
  }

  const showBaseline = report.rows.some((row) => row.baselineMin !== row.plannedMin)
  const totalBaseline = report.rows.reduce((sum, row) => sum + row.baselineMin, 0)
  const totalDelta = report.totalTrackedMin - report.totalPlannedMin

  const grid = `wide:grid wide:gap-x-3 ${showBaseline ? GRID_WITH_BASELINE : GRID_WITHOUT_BASELINE}`
  const numbers = `grid gap-1.5 ${showBaseline ? 'grid-cols-4' : 'grid-cols-3'} wide:contents`
  const number = 'flex flex-col gap-0.5 tabular-nums wide:items-end'

  return (
    <div
      role="table"
      className="overflow-hidden rounded-[22px] bg-card text-[14px] wide:rounded-none wide:bg-transparent"
    >
      <div
        role="row"
        className={`label-caps hidden tracking-[0.8px] wide:border-b wide:border-border wide:px-3 wide:pb-2.5 ${grid}`}
      >
        <span role="columnheader">Task</span>
        <span role="columnheader">Project</span>
        {showBaseline && (
          <span role="columnheader" className="text-right" title="The plan at the start of the week">
            Original
          </span>
        )}
        <span role="columnheader" className="text-right">
          Planned
        </span>
        <span role="columnheader" className="text-right">
          Actual
        </span>
        <span role="columnheader" className="text-right">
          Difference
        </span>
        <span role="columnheader">Status</span>
      </div>

      {report.rows.map((row) => {
        const delta = row.actualMin - row.plannedMin
        const replanned = row.baselineMin !== row.plannedMin
        return (
          <div
            role="row"
            key={`${row.taskTitle}-${row.projectName ?? ''}`}
            className={`flex flex-col gap-2.5 border-b border-border px-4 py-3.5 wide:h-[46px] wide:items-center wide:border-border/60 wide:px-3 wide:py-0 ${grid}`}
          >
            <div className="flex items-start justify-between gap-2.5 wide:contents">
              <div className="flex min-w-0 flex-col gap-0.5 wide:contents">
                <span role="cell" className="text-[16px] leading-tight font-bold text-text wide:truncate wide:text-[14px] wide:font-semibold">
                  {row.taskTitle}
                </span>
                <span role="cell" className="text-[13px] font-medium text-text-dim wide:truncate wide:text-[14px] wide:font-normal">
                  {row.projectName ?? '—'}
                </span>
              </div>
              <span role="cell" className="shrink-0 wide:order-last">
                <span
                  className={`inline-block rounded-pill px-2.5 py-1 text-[12px] font-bold ${
                    STATUS_STYLE[row.status] ?? 'bg-input text-text-dim'
                  }`}
                >
                  {STATUS_LABEL[row.status] ?? row.status}
                </span>
              </span>
            </div>

            <div className={numbers}>
              {showBaseline && (
                <span
                  role="cell"
                  className={`${number} font-semibold ${replanned ? 'text-warn' : 'text-text-faint'}`}
                >
                  <CellLabel>Original</CellLabel>
                  {formatDuration(row.baselineMin)}
                </span>
              )}
              <span role="cell" className={`${number} font-semibold text-text wide:font-normal wide:text-text-dim`}>
                <CellLabel>Planned</CellLabel>
                {formatDuration(row.plannedMin)}
              </span>
              <span role="cell" className={`${number} font-bold text-accent wide:text-accent-soft`}>
                <CellLabel>Actual</CellLabel>
                {formatDuration(row.actualMin)}
              </span>
              <span
                role="cell"
                className={`${number} font-semibold ${Math.abs(delta) < 15 ? 'text-text-faint' : 'text-text-dim'}`}
              >
                <CellLabel>Difference</CellLabel>
                {delta === 0
                  ? '—'
                  : `${delta > 0 ? '+' : '−'}${formatDuration(Math.abs(delta))}`}
              </span>
            </div>
          </div>
        )
      })}

      <div
        role="row"
        className={`flex flex-col gap-1.5 bg-tabbar px-4 py-3.5 font-bold wide:h-[50px] wide:items-center wide:bg-transparent wide:px-3 wide:py-0 wide:text-[15px] ${grid}`}
      >
        <span role="cell" className="text-[15px] text-text">
          Total
        </span>
        <span role="cell" className="hidden wide:block" />
        <div className={numbers}>
          {showBaseline && (
            <span role="cell" className={`${number} font-bold text-text-dim`}>
              {formatDuration(totalBaseline)}
            </span>
          )}
          <span role="cell" className={`${number} font-bold text-text`}>
            {formatDuration(report.totalPlannedMin)}
          </span>
          <span role="cell" className={`${number} font-bold text-accent wide:text-accent-soft`}>
            {formatDuration(report.totalTrackedMin)}
          </span>
          <span role="cell" className={`${number} font-bold text-text-dim`}>
            {totalDelta === 0
              ? '—'
              : `${totalDelta > 0 ? '+' : '−'}${formatDuration(Math.abs(totalDelta))}`}
          </span>
        </div>
        <span role="cell" className="hidden wide:block" />
      </div>

      {showBaseline && (
        <p className="border-t border-border px-4 py-3 text-[13px] leading-normal font-medium text-text-faint wide:border-0 wide:px-0 wide:pt-1.5 wide:pb-0 wide:font-normal">
          <span className="font-bold text-warn">Original</span> is the plan as it stood at the
          start of the week; <span className="font-bold text-text-dim">Planned</span> is how it
          looked at the end. The document explains this too, so your supervisor is not left
          guessing why there are two plan columns.
        </p>
      )}
    </div>
  )
}
