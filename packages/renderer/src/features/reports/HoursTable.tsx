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

  return (
    <div className="overflow-hidden rounded-[12px] border border-border">
      <table className="w-full text-[13px]">
        <thead className="bg-bg text-text-dim">
          <tr>
            <th className="px-4 py-2.5 text-left font-medium">Task</th>
            <th className="px-4 py-2.5 text-left font-medium">Project</th>
            {showBaseline && (
              <th className="px-4 py-2.5 text-right font-medium" title="The plan at the start of the week">
                Original
              </th>
            )}
            <th className="px-4 py-2.5 text-right font-medium">Planned</th>
            <th className="px-4 py-2.5 text-right font-medium">Actual</th>
            <th className="px-4 py-2.5 text-right font-medium">Difference</th>
            <th className="px-4 py-2.5 text-left font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row) => {
            const delta = row.actualMin - row.plannedMin
            const replanned = row.baselineMin !== row.plannedMin
            return (
              <tr key={`${row.taskTitle}-${row.projectName ?? ''}`} className="border-t border-border">
                <td className="px-4 py-2.5 text-text">{row.taskTitle}</td>
                <td className="px-4 py-2.5 text-text-dim">{row.projectName ?? '—'}</td>
                {showBaseline && (
                  <td
                    className={`px-4 py-2.5 text-right font-mono tabular-nums ${replanned ? 'text-prio-med' : 'text-text-faint'}`}
                  >
                    {formatDuration(row.baselineMin)}
                  </td>
                )}
                <td className="px-4 py-2.5 text-right font-mono text-text-dim tabular-nums">
                  {formatDuration(row.plannedMin)}
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-accent tabular-nums">
                  {formatDuration(row.actualMin)}
                </td>
                <td
                  className={`px-4 py-2.5 text-right font-mono tabular-nums ${
                    Math.abs(delta) < 15 ? 'text-text-faint' : 'text-text-dim'
                  }`}
                >
                  {delta === 0
                    ? '—'
                    : `${delta > 0 ? '+' : '−'}${formatDuration(Math.abs(delta))}`}
                </td>
                <td
                  className={`px-4 py-2.5 ${row.status === 'done' ? 'text-accent' : 'text-text-dim'}`}
                >
                  {STATUS_LABEL[row.status] ?? row.status}
                </td>
              </tr>
            )
          })}

          <tr className="border-t border-border-strong bg-bg font-medium">
            <td className="px-4 py-2.5 text-text">Total</td>
            <td />
            {showBaseline && (
              <td className="px-4 py-2.5 text-right font-mono text-text-dim tabular-nums">
                {formatDuration(totalBaseline)}
              </td>
            )}
            <td className="px-4 py-2.5 text-right font-mono text-text tabular-nums">
              {formatDuration(report.totalPlannedMin)}
            </td>
            <td className="px-4 py-2.5 text-right font-mono text-accent tabular-nums">
              {formatDuration(report.totalTrackedMin)}
            </td>
            <td className="px-4 py-2.5 text-right font-mono text-text-dim tabular-nums">
              {totalDelta === 0
                ? '—'
                : `${totalDelta > 0 ? '+' : '−'}${formatDuration(Math.abs(totalDelta))}`}
            </td>
            <td />
          </tr>
        </tbody>
      </table>

      {showBaseline && (
        <p className="border-t border-border px-4 py-3 text-[12px] leading-relaxed text-text-faint">
          <span className="text-prio-med">Original</span> is the plan as it stood at the start of
          the week; <span className="text-text-dim">Planned</span> is how it looked at the end. The
          document explains this too, so your supervisor is not left guessing why there are two
          plan columns.
        </p>
      )}
    </div>
  )
}
