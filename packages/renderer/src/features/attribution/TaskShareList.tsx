import { useMemo, useState } from 'react'
import type { Area, Task, TaskShare } from '@core/contract/types.js'
import { Button } from '../../ui/Button.js'
import { Pill } from '../../ui/Pill.js'
import { PriorityDot } from '../../ui/PriorityDot.js'
import { CloseIcon, PlusIcon, SearchIcon } from '../../ui/icons.js'
import { formatDuration } from '../../lib/format.js'

interface Props {
  shares: TaskShare[]
  onChange: (shares: TaskShare[]) => void
  /** The minutes being divided, so every row can show what its share is worth. */
  poolMin: number
  tasks: Task[]
  areaById: Map<string, Area>
  /** Shown above the picker when nothing is chosen yet. */
  emptyHint?: string
  compact?: boolean
}

/**
 * The list of tasks and their shares, with the minutes each one is worth.
 *
 * Shared by the end-of-day step and the stretch editor because it is the same question in
 * both — "what did that time go to" — and two copies of a control that writes hours is two
 * places for the rounding to disagree.
 *
 * Every row shows percent *and* minutes. A percentage is easy to type and impossible to feel,
 * and minutes are what the report sends, so the number that will actually be written sits at
 * the end of the row you are dragging.
 */
export function TaskShareList({
  shares,
  onChange,
  poolMin,
  tasks,
  areaById,
  emptyHint,
  compact = false
}: Props) {
  const [search, setSearch] = useState('')
  const [picking, setPicking] = useState(false)

  const byId = useMemo(() => {
    const map = new Map<string, Task>()
    for (const task of tasks) map.set(task.id, task)
    return map
  }, [tasks])

  const claimedPct = shares.reduce((sum, share) => sum + share.sharePct, 0)

  const setShare = (taskId: string, sharePct: number): void =>
    onChange(
      shares.map((share) => (share.taskId === taskId ? { ...share, sharePct } : share))
    )

  const addTask = (taskId: string): void => {
    setSearch('')
    setPicking(false)
    if (shares.some((share) => share.taskId === taskId)) return
    // A first task takes the whole stretch; a later one takes an equal cut of what is
    // already claimed, so adding a task never silently changes the total.
    if (shares.length === 0) onChange([{ taskId, sharePct: 100 }])
    else onChange(evenly([...shares.map((share) => share.taskId), taskId]))
  }

  const candidates = tasks
    .filter((task) => task.status !== 'archived')
    .filter((task) => !shares.some((share) => share.taskId === task.id))
    .filter((task) => task.title.toLowerCase().includes(search.trim().toLowerCase()))
    .slice(0, compact ? 6 : 8)

  const open = picking || shares.length === 0

  return (
    <div>
      {shares.length === 0 ? (
        emptyHint && <p className="pb-1 text-[13px] text-text-dim">{emptyHint}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {shares.map((share) => {
            const task = byId.get(share.taskId)
            const area = task?.areaId ? areaById.get(task.areaId) : null
            return (
              <li
                key={share.taskId}
                className="flex items-center gap-3 rounded-[10px] px-2 py-2.5 hover:bg-card-hover"
              >
                <div className="flex min-w-0 flex-1 items-center gap-2.5">
                  {task && <PriorityDot priority={task.priority} />}
                  <span className="truncate text-[14px] text-text">
                    {task?.title ?? 'Deleted task'}
                  </span>
                  {area && !compact && (
                    <Pill tone={area.countsAsStageHours ? 'accent' : 'muted'}>{area.name}</Pill>
                  )}
                </div>

                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={share.sharePct}
                  onChange={(event) => setShare(share.taskId, Number(event.target.value))}
                  className={`accent-accent ${compact ? 'w-[110px]' : 'w-[180px]'}`}
                  aria-label={`Share for ${task?.title ?? 'task'}`}
                />

                <div className="flex w-[68px] items-center gap-1">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={share.sharePct}
                    onChange={(event) => setShare(share.taskId, clamp(Number(event.target.value)))}
                    className="w-14 rounded-[8px] border border-border bg-bg px-2 py-1 text-right font-mono text-[13px] text-text outline-none tabular-nums focus:border-accent"
                  />
                  <span className="text-[13px] text-text-faint">%</span>
                </div>

                {/* The number that actually gets written. */}
                <span className="w-[70px] text-right font-mono text-[13px] text-accent tabular-nums">
                  {formatDuration(minutesFor(share.sharePct, claimedPct, poolMin))}
                </span>

                <button
                  onClick={() => onChange(shares.filter((s) => s.taskId !== share.taskId))}
                  className="text-text-faint hover:text-prio-high"
                  aria-label="Remove"
                >
                  <CloseIcon size={14} />
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <div className={`${shares.length > 0 ? 'mt-4 border-t border-border pt-4' : 'mt-2'}`}>
        {open ? (
          <div>
            <div className="flex items-center gap-2 rounded-[10px] border border-border bg-bg px-3 py-2">
              <SearchIcon size={14} />
              <input
                autoFocus
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search a task you worked on"
                className="w-full bg-transparent text-[14px] text-text outline-none placeholder:text-text-faint"
              />
            </div>
            {candidates.length > 0 && (
              <ul className="mt-2 flex flex-col">
                {candidates.map((task) => (
                  <li key={task.id}>
                    <button
                      onClick={() => addTask(task.id)}
                      className="flex w-full items-center gap-2.5 rounded-[8px] px-2 py-2 text-left hover:bg-card-hover"
                    >
                      <PriorityDot priority={task.priority} />
                      <span className="truncate text-[14px] text-text">{task.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <Button
              variant="secondary"
              size="sm"
              icon={<PlusIcon size={14} />}
              onClick={() => setPicking(true)}
            >
              Add a task
            </Button>
            {shares.length > 1 && (
              <button
                className="text-[13px] text-text-dim hover:text-accent"
                onClick={() => onChange(evenly(shares.map((share) => share.taskId)))}
              >
                Split evenly
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ helpers

const clamp = (value: number): number =>
  Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 0

/**
 * The minutes a share will actually be written as.
 *
 * The denominator is the claimed total rather than 100, matching the service: shares of 60
 * and 60 divide the stretch half and half instead of overflowing it. Below 100 the
 * denominator stays 100, so a short division leaves a remainder rather than being inflated
 * to fill the stretch.
 */
export const minutesFor = (sharePct: number, claimedPct: number, poolMin: number): number =>
  Math.round((poolMin * sharePct) / Math.max(100, claimedPct))

/** Equal shares that still add to 100, with the rounding drift on the first task. */
export function evenly(taskIds: string[]): TaskShare[] {
  if (taskIds.length === 0) return []
  const each = Math.floor(100 / taskIds.length)
  const drift = 100 - each * taskIds.length
  return taskIds.map((taskId, index) => ({
    taskId,
    sharePct: index === 0 ? each + drift : each
  }))
}

export const sameShares = (a: TaskShare[], b: TaskShare[]): boolean => {
  if (a.length !== b.length) return false
  const key = (shares: TaskShare[]): string =>
    [...shares]
      .sort((x, y) => x.taskId.localeCompare(y.taskId))
      .map((share) => `${share.taskId}:${share.sharePct}`)
      .join('|')
  return key(a) === key(b)
}
