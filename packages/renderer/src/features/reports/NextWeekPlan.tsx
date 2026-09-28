import type { CSSProperties } from 'react'
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
    // Its own card on the phone; on the desktop the section around it is already the card.
    <div className="flex flex-col rounded-[22px] bg-card px-4 pt-1.5 pb-2.5 wide:gap-3.5 wide:rounded-none wide:bg-transparent wide:p-0">
      {[...byDay.entries()].map(([date, dayBlocks], index) => {
        const minutes = dayBlocks.reduce((sum, block) => sum + (block.endMin - block.startMin), 0)
        return (
          <div
            key={date}
            className="animate-rise flex flex-col wide:gap-1.5"
            style={{ '--i': Math.min(index, 12) } as CSSProperties}
          >
            <div
              className={`flex items-baseline justify-between pt-2 pb-1.5 wide:border-b wide:border-border wide:pt-0 wide:pb-1 ${
                index > 0 ? 'mt-1 border-t border-border wide:mt-0 wide:border-t-0' : ''
              }`}
            >
              <span className="text-[14px] font-bold text-text">
                {formatLongDate(new Date(`${date}T12:00:00`))}
              </span>
              <span className="font-mono text-[13px] font-bold text-text-dim">{formatDuration(minutes)}</span>
            </div>
            {dayBlocks.map((block) => (
              <div
                key={block.id}
                className="flex items-baseline gap-3 py-[5px] text-[14px] wide:grid wide:grid-cols-[116px_minmax(0,1fr)_auto] wide:items-center wide:gap-x-2.5 wide:py-0"
              >
                <span className="w-[104px] shrink-0 font-mono text-[13px] font-semibold text-text-dim tabular-nums wide:w-auto wide:text-[14px]">
                  {formatMinuteOfDay(block.startMin)} – {formatMinuteOfDay(block.endMin)}
                </span>
                <div className="flex min-w-0 flex-1 flex-col wide:contents">
                  <span className="min-w-0 truncate font-semibold text-text">{block.taskTitle}</span>
                  <span className="shrink-0 text-[12px] font-medium text-text-faint wide:text-[13px] wide:font-normal">
                    {block.projectName ?? '—'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}
