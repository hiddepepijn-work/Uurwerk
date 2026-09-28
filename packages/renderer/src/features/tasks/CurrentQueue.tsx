import type { Area, Task } from '@core/contract/types.js'
import { Card } from '../../ui/Card.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { formatDuration } from '../../lib/format.js'
import { TaskRow } from './TaskRow.js'

/**
 * The working order: what to pick up next, top to bottom. Unlike the priority view this is
 * a single flat list, because at any moment there is exactly one next thing.
 */
export function CurrentQueue({
  tasks,
  activeTaskId,
  areaById,
  waitingOnByTask,
  onToggleComplete,
  onStart,
  onEdit
}: {
  tasks: Task[]
  activeTaskId: string | null
  areaById: Map<string, Area>
  /** Unfinished hard prerequisites per task. */
  waitingOnByTask?: Map<string, number>
  onToggleComplete: (task: Task) => void
  onStart: (task: Task) => void
  onEdit: (task: Task) => void
}) {
  const estimated = tasks.reduce((sum, task) => sum + (task.estimateMin ?? 0), 0)

  return (
    <Card padded={false} className="flex min-h-0 flex-col overflow-hidden wide:px-[18px] wide:pt-[18px] wide:pb-3.5">
      {/* Phone: a Bricolage heading like the other cards; wide: the quieter panel label. */}
      <h2 className="px-4 pt-4 pb-2 font-display text-[20px] font-bold text-text wide:p-0 wide:pb-2.5 wide:font-sans wide:text-[16px]">
        Current queue
      </h2>

      <div className="min-h-0 flex-1 overflow-y-auto wide:flex wide:flex-col wide:gap-1">
        {tasks.length === 0 ? (
          <EmptyState title="Nothing in the queue." hint="Add a task to start tracking against it." />
        ) : (
          tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              active={task.id === activeTaskId}
              showDot={false}
              area={task.areaId ? (areaById.get(task.areaId) ?? null) : null}
              waitingOn={waitingOnByTask?.get(task.id) ?? 0}
              onToggleComplete={onToggleComplete}
              onStart={onStart}
              onEdit={onEdit}
            />
          ))
        )}
      </div>

      <footer className="flex items-center justify-between border-t border-border px-4 py-3 font-mono text-[13px] font-bold text-text-faint wide:mt-2.5 wide:px-0 wide:pt-2.5 wide:pb-0 wide:font-normal">
        <span>
          {tasks.length} task{tasks.length === 1 ? '' : 's'}
        </span>
        <span>Est. total {formatDuration(estimated)}</span>
      </footer>
    </Card>
  )
}
