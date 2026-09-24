import type { Area, Priority, Task } from '@core/contract/types.js'
import { Card } from '../../ui/Card.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { PriorityDot, PRIORITY_LABEL } from '../../ui/PriorityDot.js'
import { FolderIcon, GearIcon } from '../../ui/icons.js'
import { formatDuration } from '../../lib/format.js'

const ORDER: Priority[] = ['high', 'medium', 'low']

/**
 * The same tasks, grouped by priority, with due date and logged time.
 *
 * This is the view that answers "am I spending my time on the right things" — which is
 * exactly the question a supervisor asks, so the columns match the report's columns.
 */
export function PriorityView({
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
  return (
    <Card title="Priority view" padded={false} className="flex min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-5 pt-1">
        {tasks.length === 0 ? (
          <EmptyState title="No tasks yet." />
        ) : (
          ORDER.map((priority) => {
            const group = tasks.filter((task) => task.priority === priority)
            if (group.length === 0) return null

            return (
              <section key={priority} className="mb-5 overflow-hidden rounded-[10px] border border-border">
                <header className="flex items-center gap-2.5 border-b border-border bg-bg px-4 py-2.5">
                  <PriorityDot priority={priority} />
                  <span className="text-[13px] font-medium text-text">{PRIORITY_LABEL[priority]}</span>
                  <span className="rounded-full bg-card px-2 py-0.5 text-[11px] text-text-dim">
                    {group.length}
                  </span>
                  <span className="ml-auto flex gap-10 text-[12px] text-text-dim">
                    <span>Due</span>
                    <span>Logged</span>
                  </span>
                </header>

                <ul>
                  {group.map((task) => (
                    <li
                      key={task.id}
                      className={`flex items-center gap-3.5 border-b border-border px-4 py-3 last:border-b-0
                        ${task.id === activeTaskId ? 'bg-rail-active' : ''}`}
                    >
                      <button
                        onClick={() => onToggleComplete(task)}
                        aria-label="Toggle complete"
                        className={`h-[17px] w-[17px] shrink-0 rounded-full border transition-colors
                          ${task.status === 'done' ? 'border-accent bg-accent' : 'border-border-strong hover:border-accent'}`}
                      />
                      <button onClick={() => onStart(task)} className="min-w-0 flex-1 text-left">
                        <div className="truncate text-[14px] text-text">{task.title}</div>
                        <div className="mt-1 flex items-center gap-2 truncate text-[12px] text-text-dim">
                          {task.projectName && (
                            <span className="flex items-center gap-1.5 truncate">
                              <FolderIcon size={12} />
                              {task.projectName}
                            </span>
                          )}
                          {(() => {
                            const area = task.areaId ? areaById.get(task.areaId) : null
                            if (!area) return null
                            return (
                              <span
                                className={`rounded-full border px-2 py-0.5 text-[11px] ${
                                  area.countsAsStageHours
                                    ? 'border-accent/30 bg-accent/10 text-accent'
                                    : 'border-border bg-bg text-text-dim'
                                }`}
                              >
                                {area.name}
                              </span>
                            )
                          })()}
                          {(waitingOnByTask?.get(task.id) ?? 0) > 0 && task.status !== 'done' && (
                            <span
                              title="The planner leaves this out until its prerequisites are finished."
                              className="rounded-full border border-border bg-bg px-2 py-0.5 text-[11px] text-text-dim"
                            >
                              waits for {waitingOnByTask!.get(task.id)}
                            </span>
                          )}
                        </div>
                      </button>
                      <span className="w-20 shrink-0 text-right text-[13px] text-text-dim">
                        {task.dueDate ? formatDue(task.dueDate) : '—'}
                      </span>
                      <span className="w-28 shrink-0 text-right font-mono text-[13px] text-text-dim">
                        {formatDuration(task.loggedMin)} logged
                      </span>
                      <button
                        onClick={() => onEdit(task)}
                        aria-label="Edit task"
                        className="shrink-0 rounded-md p-1.5 text-text-faint transition-colors hover:bg-card hover:text-text"
                      >
                        <GearIcon size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )
          })
        )}
      </div>
    </Card>
  )
}

/** "12 May" — short, because the year is almost always the current one. */
function formatDue(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(
    new Date(y!, (m ?? 1) - 1, d ?? 1)
  )
}
