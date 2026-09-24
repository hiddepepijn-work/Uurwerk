import type { Area, Task } from '@core/contract/types.js'
import { PriorityDot } from '../../ui/PriorityDot.js'
import { FolderIcon, GearIcon } from '../../ui/icons.js'
import { formatDuration } from '../../lib/format.js'

interface Props {
  task: Task
  /** True when the timer is currently running on this task. */
  active?: boolean
  showDot?: boolean
  /** Resolved from the task's areaId; drives the badge. */
  area?: Area | null
  /** Unfinished hard prerequisites. Above zero, the planner cannot schedule this at all. */
  waitingOn?: number
  right?: React.ReactNode
  onToggleComplete: (task: Task) => void
  onStart: (task: Task) => void
  onEdit?: (task: Task) => void
}

/**
 * One task, one line. The checkbox completes it; the rest of the row starts the timer on
 * it. Two targets, no menu, nothing hidden behind a hover state.
 */
export function TaskRow({
  task,
  active,
  showDot = true,
  area,
  waitingOn = 0,
  right,
  onToggleComplete,
  onStart,
  onEdit
}: Props) {
  const done = task.status === 'done'

  return (
    <div
      className={`flex items-center gap-3.5 rounded-[10px] border px-4 py-3.5 transition-colors
        ${active ? 'border-accent/40 bg-rail-active' : 'border-transparent hover:bg-card-hover'}`}
    >
      {active && <span className="-my-3.5 -ml-4 mr-0 h-[52px] w-[3px] shrink-0 rounded-r bg-accent" />}

      <button
        onClick={() => onToggleComplete(task)}
        aria-label={done ? 'Reopen task' : 'Complete task'}
        className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border transition-colors
          ${done ? 'border-accent bg-accent text-[#06210F]' : 'border-border-strong hover:border-accent'}`}
      >
        {done && (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        )}
      </button>

      {showDot && <PriorityDot priority={task.priority} />}

      <button onClick={() => onStart(task)} className="group min-w-0 flex-1 text-left">
        <div className={`truncate text-[14px] ${done ? 'text-text-dim line-through' : 'text-text'}`}>
          {task.title}
        </div>
        <div className="mt-1 flex items-center gap-2 truncate text-[12px] text-text-dim">
          {task.projectName && (
            <span className="flex items-center gap-1.5 truncate">
              <FolderIcon size={12} />
              {task.projectName}
            </span>
          )}
          {/* The badge answers the question the task list otherwise hides: does this
              time count toward the internship? */}
          {area && (
            <span
              className={`rounded-full border px-2 py-0.5 text-[11px] ${
                area.countsAsStageHours
                  ? 'border-accent/30 bg-accent/10 text-accent'
                  : 'border-border bg-bg text-text-dim'
              }`}
            >
              {area.name}
            </span>
          )}
          {task.status === 'blocked' && (
            <span className="rounded-full border border-prio-med/30 bg-prio-med/10 px-2 py-0.5 text-[11px] text-prio-med">
              {task.blockedReason ?? 'blocked'}
            </span>
          )}
          {/* Without this the task simply never appears in a plan, and nothing says why. */}
          {waitingOn > 0 && task.status !== 'done' && (
            <span
              title="The planner leaves this out until its prerequisites are finished."
              className="rounded-full border border-border bg-bg px-2 py-0.5 text-[11px] text-text-dim"
            >
              waits for {waitingOn}
            </span>
          )}
        </div>
      </button>

      {right ?? (
        <span className="shrink-0 font-mono text-[13px] text-text-dim">
          {task.estimateMin ? formatDuration(task.estimateMin) : formatDuration(task.loggedMin)}
        </span>
      )}

      {onEdit && (
        <button
          onClick={() => onEdit(task)}
          aria-label="Edit task"
          className="shrink-0 rounded-md p-1.5 text-text-faint transition-colors hover:bg-card hover:text-text"
        >
          <GearIcon size={14} />
        </button>
      )}
    </div>
  )
}
