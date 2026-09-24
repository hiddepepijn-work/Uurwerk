import type { Task } from '@core/contract/types.js'
import { Card, CardAction } from '../../ui/Card.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { PriorityDot } from '../../ui/PriorityDot.js'
import { formatDuration } from '../../lib/format.js'

interface Props {
  tasks: Task[]
  activeTaskId: string | null
  onSelect: (task: Task) => void
  onSeeAll: () => void
}

/**
 * The three things that matter now. Clicking one starts the timer on it — the shortest
 * possible path from "what should I do" to "I am doing it".
 */
export function TopPriority({ tasks, activeTaskId, onSelect, onSeeAll }: Props) {
  return (
    <Card title="Top priority" action={<CardAction onClick={onSeeAll}>See all</CardAction>} padded={false}>
      {tasks.length === 0 ? (
        <EmptyState title="No open tasks." hint="Press Ctrl+Alt+T to add one without leaving what you are doing." />
      ) : (
        <ul className="flex flex-col gap-2 p-5 pt-4">
          {tasks.map((task) => {
            const isActive = task.id === activeTaskId
            return (
              <li key={task.id}>
                <button
                  onClick={() => onSelect(task)}
                  className={`flex w-full items-center gap-3 rounded-[10px] border p-3.5 text-left transition-colors
                    ${
                      isActive
                        ? 'border-accent/40 bg-rail-active'
                        : 'border-border bg-bg hover:bg-card-hover'
                    }`}
                >
                  <PriorityDot priority={task.priority} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] text-text">{task.title}</div>
                    {task.projectName && (
                      <div className="mt-0.5 truncate text-[12px] text-text-dim">{task.projectName}</div>
                    )}
                  </div>
                  <div className="shrink-0 font-mono text-[13px] text-text-dim">
                    {task.estimateMin ? formatDuration(task.estimateMin) : formatDuration(task.loggedMin)}
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}
