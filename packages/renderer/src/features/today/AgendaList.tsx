import type { PlanBlock } from '@core/contract/types.js'
import { Card, CardAction } from '../../ui/Card.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { CalendarIcon } from '../../ui/icons.js'
import { formatDuration, formatMinuteOfDay } from '../../lib/format.js'

/** What you planned for today: the accepted day plan, not what actually happened. */
export function AgendaList({
  blocks,
  onPlanDay
}: {
  blocks: PlanBlock[]
  onPlanDay: () => void
}) {
  const total = blocks
    .filter((block) => block.kind === 'task')
    .reduce((sum, block) => sum + (block.endMin - block.startMin), 0)

  return (
    <Card
      title="Today's agenda"
      action={<CardAction onClick={onPlanDay}>{blocks.length > 0 ? 'Edit' : 'Plan'}</CardAction>}
      padded={false}
    >
      {blocks.length === 0 ? (
        <EmptyState
          icon={<CalendarIcon size={22} />}
          title="Nothing planned for today."
          hint="Set your working hours and drop a few tasks in."
        />
      ) : (
        <>
          <ul className="flex flex-col gap-4 p-5 pt-4">
            {blocks.map((block) => (
              <li key={block.id} className="flex gap-4">
                <span className="w-11 shrink-0 pt-0.5 font-mono text-[13px] text-text-dim tabular-nums">
                  {formatMinuteOfDay(block.startMin)}
                </span>
                <span
                  className="w-[2px] shrink-0 rounded-full"
                  style={{
                    background:
                      block.kind === 'break'
                        ? 'var(--color-border-strong)'
                        : (block.projectColor ?? 'var(--color-block-blue)')
                  }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-[14px] text-text">
                      {block.taskTitle ?? block.title ?? 'Untitled'}
                    </span>
                    {block.locked && <span className="shrink-0 text-[11px]">🔒</span>}
                  </div>
                  <div className="mt-0.5 truncate text-[12px] text-text-dim">
                    {block.projectName ?? (block.kind === 'break' ? 'Break' : '')}
                    <span className="ml-2 text-text-faint">
                      {formatDuration(block.endMin - block.startMin)}
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <footer className="border-t border-border px-5 py-3 text-[13px] text-text-dim">
            {formatDuration(total)} planned
          </footer>
        </>
      )}
    </Card>
  )
}
