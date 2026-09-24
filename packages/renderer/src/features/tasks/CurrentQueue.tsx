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
    <Card title="Current queue" padded={false} className="flex min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-1 pb-2">
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

      <footer className="flex items-center justify-between border-t border-border px-5 py-3.5 text-[13px] text-text-dim">
        <span>
          {tasks.length} task{tasks.length === 1 ? '' : 's'}
        </span>
        <span>Est. total {formatDuration(estimated)}</span>
      </footer>
    </Card>
  )
}
