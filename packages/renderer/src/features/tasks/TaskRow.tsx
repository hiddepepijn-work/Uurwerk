import type { Area, Task } from '@core/contract/types.js'
import { PriorityDot } from '../../ui/PriorityDot.js'
import { FolderIcon, GearIcon } from '../../ui/icons.js'
import { formatDuration } from '../../lib/format.js'
import { AreaChip } from './AreaChip.js'

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
    // Phone: full-width rows split by hairlines. Wide: separate rounded rows inside the card.
    <div
      className={`relative flex items-start gap-3 border-t border-border py-3 pr-3.5 pl-4 transition-colors
        wide:items-center wide:rounded-button wide:border-t-0 wide:py-2.5 wide:pr-2.5
        ${active ? 'bg-rail-active' : 'hover:bg-card-hover'}`}
    >
      {active && (
        <span className="absolute top-0 bottom-0 left-0 w-[3px] bg-accent wide:top-2.5 wide:bottom-2.5 wide:rounded-r-sm" />
      )}

      <button
        onClick={() => onToggleComplete(task)}
        aria-label={done ? 'Reopen task' : 'Complete task'}
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors wide:mt-0 wide:h-[18px] wide:w-[18px]
          ${done ? 'border-accent bg-accent text-accent-ink' : 'border-text-faint/70 hover:border-accent'}`}
      >
        {done && (
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        )}
      </button>

      {showDot && (
        <span className="mt-[7px] flex shrink-0 wide:mt-0">
          <PriorityDot priority={task.priority} />
        </span>
      )}

      <button onClick={() => onStart(task)} className="group min-w-0 flex-1 text-left">
        <div
          className={`text-[16px] leading-tight font-bold wide:truncate wide:text-[15px] ${
            done ? 'text-text-faint line-through' : 'text-text'
          }`}
        >
          {task.title}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[13px] text-text-dim">
          {task.projectName && (
            <span className="flex min-w-0 items-center gap-1 truncate font-semibold wide:font-normal">
              <FolderIcon size={13} />
              {task.projectName}
            </span>
          )}
          {/* The badge answers the question the task list otherwise hides: does this
              time count toward the internship? */}
          <AreaChip area={area ?? null} />
          {task.status === 'blocked' && (
            <span className="rounded-pill bg-warn-soft px-[9px] py-0.5 text-[12px] font-bold text-warn">
              {task.blockedReason ?? 'blocked'}
            </span>
          )}
          {/* Without this the task simply never appears in a plan, and nothing says why. */}
          {waitingOn > 0 && task.status !== 'done' && (
            <span
              title="The planner leaves this out until its prerequisites are finished."
              className="rounded-pill bg-input px-[9px] py-0.5 text-[12px] font-bold text-text-dim"
            >
              waits for {waitingOn}
            </span>
          )}
        </div>
      </button>

      {right ?? (
        <span
          className={`mt-0.5 shrink-0 font-mono text-[14px] font-bold whitespace-nowrap wide:mt-0 ${
            active ? 'text-accent-soft' : 'text-text-dim'
          }`}
        >
          {task.estimateMin ? formatDuration(task.estimateMin) : formatDuration(task.loggedMin)}
        </span>
      )}

      {onEdit && (
        <button
          onClick={() => onEdit(task)}
          aria-label="Edit task"
          title="Edit task"
          className="-mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-text-faint transition-colors hover:bg-input hover:text-text wide:mt-0"
        >
          <GearIcon size={16} />
        </button>
      )}
    </div>
  )
}
