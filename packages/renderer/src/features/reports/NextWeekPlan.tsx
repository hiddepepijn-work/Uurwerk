import type { PlannedBlock } from '@core/contract/types.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { CalendarIcon } from '../../ui/icons.js'
import { formatDuration, formatLongDate, formatMinuteOfDay } from '../../lib/format.js'

/**
 * What is already scheduled for the week after this one.
 *
 * Grouped per day rather than listed flat, because a supervisor reading "next week" wants
 * the shape of the week, not seventeen rows sorted by time.
 */
export function NextWeekPlan({ blocks }: { blocks: PlannedBlock[] }) {
  if (blocks.length === 0) {
    return (
      <EmptyState
        icon={<CalendarIcon size={26} />}
        title="Nothing planned for next week yet."
        hint="Plan a day in the Week screen and it appears here — and in the document."
      />
    )
  }

  const byDay = new Map<string, PlannedBlock[]>()
  for (const block of blocks) {
    byDay.set(block.date, [...(byDay.get(block.date) ?? []), block])
  }

  return (
    <div className="overflow-hidden rounded-[12px] border border-border">
      {[...byDay.entries()].map(([date, dayBlocks]) => {
        const minutes = dayBlocks.reduce((sum, block) => sum + (block.endMin - block.startMin), 0)
        return (
          <div key={date} className="border-b border-border last:border-b-0">
            <div className="flex items-baseline justify-between bg-bg px-4 py-2">
              <span className="text-[13px] text-text">
                {formatLongDate(new Date(`${date}T12:00:00`))}
              </span>
              <span className="font-mono text-[12px] text-text-dim">{formatDuration(minutes)}</span>
            </div>
            {dayBlocks.map((block) => (
              <div key={block.id} className="flex items-center gap-4 px-4 py-2 text-[13px]">
                <span className="w-[104px] shrink-0 font-mono text-text-faint tabular-nums">
                  {formatMinuteOfDay(block.startMin)} – {formatMinuteOfDay(block.endMin)}
                </span>
                <span className="min-w-0 flex-1 truncate text-text">{block.taskTitle}</span>
                <span className="shrink-0 text-text-dim">{block.projectName ?? '—'}</span>
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}
