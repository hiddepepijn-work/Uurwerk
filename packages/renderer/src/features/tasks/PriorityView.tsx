import type { Area, Priority, Task } from '@core/contract/types.js'
import { Card } from '../../ui/Card.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { PriorityDot, PRIORITY_LABEL } from '../../ui/PriorityDot.js'
import { GearIcon } from '../../ui/icons.js'
import { formatDuration } from '../../lib/format.js'
import { colorFor } from '../agenda/agenda-model.js'
import { DrawnCheck, Sparks, strikeStyle, useCompletion } from './completion.js'

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
  const today = todayIso()

  return (
    <Card padded={false} className="flex min-h-0 flex-col overflow-hidden pt-4 pb-1.5 wide:p-[18px]">
      <h2 className="px-4 pb-1 font-display text-[20px] font-bold text-text wide:px-0 wide:pb-3.5 wide:font-sans wide:text-[16px]">
        Priority view
      </h2>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto wide:gap-3.5">
        {tasks.length === 0 ? (
          <EmptyState title="No tasks yet." />
        ) : (
          ORDER.map((priority) => {
            const group = tasks.filter((task) => task.priority === priority)
            if (group.length === 0) return null

            return (
              <section key={priority} className="flex flex-col wide:gap-1">
                <header className="flex items-center gap-2 pt-2.5 pr-1.5 pb-1.5 pl-4 wide:border-b wide:border-border wide:px-1 wide:pt-1">
                  <PriorityDot priority={priority} />
                  <span className="text-[15px] font-bold text-text wide:text-[14px]">{PRIORITY_LABEL[priority]}</span>
                  <span className="rounded-pill bg-input px-2 py-px text-[12px] font-bold text-text-dim">
                    {group.length}
                  </span>
                  <span className="ml-auto flex items-center gap-2.5 text-[12px] font-bold tracking-[0.6px] text-text-faint wide:gap-3">
                    <span className="w-[52px] wide:w-16 wide:text-right">Due</span>
                    <span className="w-[104px] wide:w-[92px] wide:text-right">Logged</span>
                    <span className="hidden w-8 wide:block" />
                  </span>
                </header>

                <ul>
                  {group.map((task) => {
                    const area = task.areaId ? areaById.get(task.areaId) : null
                    const waitingOn = waitingOnByTask?.get(task.id) ?? 0
                    const overdue = Boolean(task.dueDate && task.dueDate < today && task.status !== 'done')

                    return (
                      <PriorityRow
                        key={task.id}
                        task={task}
                        active={task.id === activeTaskId}
                        area={area ?? null}
                        waitingOn={waitingOn}
                        overdue={overdue}
                        onToggleComplete={onToggleComplete}
                        onStart={onStart}
                        onEdit={onEdit}
                      />
                    )
                  })}
                </ul>
              </section>
            )
          })
        )}
      </div>
    </Card>
  )
}

/** One task in the priority view. Its own component so each row can play its completion. */
function PriorityRow({
  task,
  active,
  area,
  waitingOn,
  overdue,
  onToggleComplete,
  onStart,
  onEdit
}: {
  task: Task
  active: boolean
  area: Area | null
  waitingOn: number
  overdue: boolean
  onToggleComplete: (task: Task) => void
  onStart: (task: Task) => void
  onEdit: (task: Task) => void
}) {
  const completion = useCompletion<HTMLLIElement>(task, onToggleComplete)
  const done = task.status === 'done'

  return (
    <li
      ref={completion.row}
      className={`flex items-center gap-2.5 border-t border-border py-2.5 pr-1.5 pl-4
        wide:gap-3 wide:rounded-input wide:border-t-0 wide:px-1 wide:py-2
        ${active ? 'bg-rail-active' : ''}`}
    >
      <button
        onClick={completion.toggle}
        aria-label="Toggle complete"
        className={`relative flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-2 text-accent-ink transition-colors duration-[250ms]
          ${done || completion.checked ? 'border-accent bg-accent' : 'border-text-faint/70 hover:border-accent'}`}
      >
        {/* Drawn only while it is being ticked: a saved done task keeps its plain filled circle. */}
        <DrawnCheck drawn={completion.checked} size={10} />
        {completion.checked && <Sparks color={colorFor(task.areaId).soft} />}
      </button>
      <button onClick={() => onStart(task)} className="min-w-0 flex-1 text-left">
        <div
          className={`text-[14px] leading-tight font-bold transition-colors wide:truncate wide:text-[15px] ${
            completion.checked ? 'text-text-dim' : 'text-text'
          }`}
        >
          <span style={strikeStyle(completion.checked)}>{task.title}</span>
        </div>
        <div className="mt-0.5 truncate text-[12px] font-semibold text-text-dim wide:text-[13px] wide:font-normal">
          {[task.projectName, area?.name].filter(Boolean).join(' · ')}
          {waitingOn > 0 && task.status !== 'done' && (
            <span title="The planner leaves this out until its prerequisites are finished.">
              {task.projectName || area ? ' · ' : ''}waits for {waitingOn}
            </span>
          )}
        </div>
      </button>
      <span
        className={`w-[52px] shrink-0 font-mono text-[13px] font-bold wide:w-16 wide:text-right wide:text-[14px] wide:font-semibold ${
          !task.dueDate
            ? 'text-text-faint'
            : overdue
              ? 'text-danger-text'
              : 'text-text wide:text-text-dim'
        }`}
      >
        {task.dueDate ? formatDue(task.dueDate) : '—'}
      </span>
      <span className="w-[66px] shrink-0 font-mono text-[12px] font-semibold text-text-dim wide:w-[92px] wide:text-right wide:text-[14px]">
        {formatDuration(task.loggedMin)} logged
      </span>
      <button
        onClick={() => onEdit(task)}
        aria-label="Edit task"
        title="Edit task"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[10px] text-text-faint transition-colors hover:bg-input hover:text-text wide:h-8 wide:w-8"
      >
        <GearIcon size={16} />
      </button>
    </li>
  )
}

/** "12 May" — short, because the year is almost always the current one. */
function formatDue(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(
    new Date(y!, (m ?? 1) - 1, d ?? 1)
  )
}

/** Local calendar date as YYYY-MM-DD, to colour a due date that has already passed. */
function todayIso(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
