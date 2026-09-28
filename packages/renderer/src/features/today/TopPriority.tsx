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
        <ul className="flex flex-col gap-2 px-4 pt-3 pb-4 wide:gap-2.5 wide:px-5 wide:pb-5">
          {tasks.map((task) => {
            const isActive = task.id === activeTaskId
            return (
              <li key={task.id}>
                <button
                  onClick={() => onSelect(task)}
                  className={`flex w-full items-center gap-3 rounded-[16px] border-[1.5px] p-3 text-left transition-colors
                    wide:rounded-button wide:py-2.5
                    ${
                      isActive
                        ? 'border-accent bg-rail-active'
                        : 'border-transparent bg-card-hover hover:bg-secondary'
                    }`}
                >
                  <PriorityDot priority={task.priority} />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="truncate text-[15px] font-bold text-text">{task.title}</div>
                    {task.projectName && (
                      <div className="truncate text-[13px] font-medium text-text-dim">{task.projectName}</div>
                    )}
                  </div>
                  <div
                    className={`shrink-0 font-mono text-[14px] font-bold ${
                      isActive ? 'text-accent-soft' : 'text-text-dim'
                    }`}
                  >
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
