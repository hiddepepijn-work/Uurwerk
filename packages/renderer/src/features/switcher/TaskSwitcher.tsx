import { useEffect, useMemo, useRef, useState } from 'react'
import type { Area, PlannedBlock, Task } from '@core/contract/types.js'
import { api } from '../../api/client.js'
import { useLiveQuery } from '../../hooks/useLiveQuery.js'
import { useThisWeek, useToday } from '../../hooks/useToday.js'
import type { Tracking } from '../../hooks/useTracking.js'
import { Button } from '../../ui/Button.js'
import { Modal } from '../../ui/Modal.js'
import { PriorityDot } from '../../ui/PriorityDot.js'
import { CheckIcon, ClockIcon, PlayIcon, PlusIcon, SearchIcon, ShieldIcon } from '../../ui/icons.js'
import { formatDuration, formatMinuteOfDay } from '../../lib/format.js'

interface Props {
  open: boolean
  tracking: Tracking
  onClose: () => void
}

type Action = 'switch' | 'complete' | 'block'

/**
 * The task picker behind START and the switch hotkey.
 *
 * Grouped by how you actually decide what to do next: what you are on now, what the plan
 * says is next, the rest of today, and then everything else. Picking a task switches
 * without ending the run — the working stretch stays continuous.
 */
export function TaskSwitcher({ open, tracking, onClose }: Props) {
  const today = useToday()
  const week = useThisWeek()

  const [search, setSearch] = useState('')
  const [action, setAction] = useState<Action>('switch')
  const [blockReason, setBlockReason] = useState('waiting for supervisor')
  const [pendingLeave, setPendingLeave] = useState<Task | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const { data: tasks } = useLiveQuery((client) => client.tasks.list(), ['tasks'], [])
  const { data: areas } = useLiveQuery((client) => client.areas.list(), ['settings'], [])
  const { data: organizations } = useLiveQuery(
    (client) => client.organizations.list(),
    ['settings'],
    []
  )
  const { data: planned } = useLiveQuery(
    (client) => client.planning.week(week),
    ['planning'],
    [week]
  )
  const { data: recentSegments } = useLiveQuery(
    (client) => client.tracking.segmentsByWeek(week),
    ['sessions'],
    [week]
  )

  useEffect(() => {
    if (!open) return
    setSearch('')
    setAction('switch')
    setPendingLeave(null)
    // Focus the field, so the whole flow is typing plus Enter.
    setTimeout(() => inputRef.current?.focus(), 30)
  }, [open])

  const areaById = useMemo(
    () => new Map((areas ?? []).map((area) => [area.id, area])),
    [areas]
  )
  const organizationById = useMemo(
    () => new Map((organizations ?? []).map((organization) => [organization.id, organization])),
    [organizations]
  )
  const openTasks = useMemo(
    () => (tasks ?? []).filter((task) => task.status !== 'done' && task.status !== 'archived'),
    [tasks]
  )
  const byId = useMemo(() => new Map(openTasks.map((task) => [task.id, task])), [openTasks])

  const current = tracking.segment
  const currentArea = current?.areaId ? areaById.get(current.areaId) : null

  const agenda = useMemo(
    () => (planned ?? []).filter((block) => block.date === today).sort((a, b) => a.startMin - b.startMin),
    [planned, today]
  )

  /** The first planned block today that is not done and is not already running. */
  const nextPlanned = useMemo(() => {
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes()
    return (
      agenda.find(
        (block) => block.endMin > nowMin && block.taskId !== current?.taskId && byId.has(block.taskId)
      ) ?? null
    )
  }, [agenda, current?.taskId, byId])

  const recentTasks = useMemo(() => {
    const seen = new Set<string>()
    const out: Task[] = []
    for (const segment of [...(recentSegments ?? [])].reverse()) {
      if (!segment.taskId || seen.has(segment.taskId)) continue
      if (segment.taskId === current?.taskId) continue
      seen.add(segment.taskId)
      const task = byId.get(segment.taskId)
      if (task) out.push(task)
      if (out.length >= 4) break
    }
    return out
  }, [recentSegments, byId, current?.taskId])

  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return []
    return openTasks
      .filter(
        (task) =>
          task.title.toLowerCase().includes(needle) ||
          (task.projectName ?? '').toLowerCase().includes(needle)
      )
      .slice(0, 8)
  }, [openTasks, search])

  // ------------------------------------------------------------------ acting

  const leavesStageHours = (task: Task): boolean => {
    if (!currentArea?.countsAsStageHours) return false
    const target = task.areaId ? areaById.get(task.areaId) : null
    return !target?.countsAsStageHours
  }

  const run = async (task: Task | null): Promise<void> => {
    setBusy(true)
    try {
      if (!task) {
        await tracking.stop()
      } else if (!tracking.running) {
        await tracking.start(task.id)
      } else if (action === 'complete') {
        await tracking.completeAndSwitch(task.id)
      } else if (action === 'block') {
        await tracking.blockAndSwitch(blockReason, task.id)
      } else {
        await tracking.switchTask(task.id)
      }
      onClose()
    } finally {
      setBusy(false)
      setPendingLeave(null)
    }
  }

  /** Leaving internship hours is confirmed, never silent. */
  const choose = (task: Task): void => {
    if (leavesStageHours(task)) setPendingLeave(task)
    else void run(task)
  }

  const createAndStart = async (): Promise<void> => {
    const title = search.trim()
    if (!title) return
    setBusy(true)
    try {
      const task = await api.tasks.create({ title })
      if (tracking.running) await tracking.switchTask(task.id)
      else await tracking.start(task.id)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  // ------------------------------------------------------------------ render

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={720}
      title={tracking.running ? 'Switch task' : 'What are you working on?'}
      subtitle={
        tracking.running
          ? 'Switching keeps the current working session running — no gap in your log.'
          : 'Pick a task to start tracking against.'
      }
    >
      {pendingLeave ? (
        <LeaveStageConfirm
          task={pendingLeave}
          fromArea={currentArea?.name ?? 'Stage'}
          toArea={(pendingLeave.areaId ? areaById.get(pendingLeave.areaId)?.name : null) ?? 'no area'}
          toOrganization={
            pendingLeave.organizationId
              ? (organizationById.get(pendingLeave.organizationId)?.name ?? null)
              : null
          }
          onCancel={() => setPendingLeave(null)}
          onConfirm={() => void run(pendingLeave)}
          busy={busy}
        />
      ) : (
        <div className="flex flex-col gap-6">
          {current && (
            <CurrentTask
              title={current.taskTitle ?? 'Unassigned activity'}
              project={current.projectName}
              area={currentArea ?? null}
              elapsedSec={tracking.elapsedSec}
              action={action}
              onAction={setAction}
              blockReason={blockReason}
              onBlockReason={setBlockReason}
            />
          )}

          <div className="relative">
            <span className="absolute top-1/2 left-3.5 -translate-y-1/2 text-text-dim">
              <SearchIcon size={16} />
            </span>
            <input
              ref={inputRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                if (matches[0]) choose(matches[0])
                else if (search.trim()) void createAndStart()
              }}
              placeholder="Search tasks, or type a new one and press Enter..."
              className="w-full rounded-[10px] border border-border bg-bg py-3 pr-4 pl-10 text-[14px] text-text outline-none placeholder:text-text-faint focus:border-accent"
            />
          </div>

          {search.trim() ? (
            <Group title={`Matches for "${search.trim()}"`}>
              {matches.map((task) => (
                <TaskOption
                  key={task.id}
                  task={task}
                  area={task.areaId ? (areaById.get(task.areaId) ?? null) : null}
                  onSelect={choose}
                />
              ))}
              <button
                onClick={() => void createAndStart()}
                disabled={busy}
                className="flex w-full items-center gap-3 rounded-[10px] border border-dashed border-border px-4 py-3 text-left transition-colors hover:bg-card-hover"
              >
                <span className="text-accent">
                  <PlusIcon size={16} />
                </span>
                <span className="text-[14px] text-text">
                  Create and start &ldquo;{search.trim()}&rdquo;
                </span>
              </button>
            </Group>
          ) : (
            <>
              {nextPlanned && byId.get(nextPlanned.taskId) && (
                <Group title="Next in today's plan">
                  <TaskOption
                    task={byId.get(nextPlanned.taskId)!}
                    area={
                      byId.get(nextPlanned.taskId)!.areaId
                        ? (areaById.get(byId.get(nextPlanned.taskId)!.areaId!) ?? null)
                        : null
                    }
                    hint={`${formatMinuteOfDay(nextPlanned.startMin)} – ${formatMinuteOfDay(nextPlanned.endMin)}`}
                    onSelect={choose}
                  />
                </Group>
              )}

              <Group title="Planned today">
                {agenda
                  .filter((block) => block.taskId !== nextPlanned?.taskId && byId.has(block.taskId))
                  .map((block: PlannedBlock) => (
                    <TaskOption
                      key={block.id}
                      task={byId.get(block.taskId)!}
                      area={
                        byId.get(block.taskId)!.areaId
                          ? (areaById.get(byId.get(block.taskId)!.areaId!) ?? null)
                          : null
                      }
                      hint={`${formatMinuteOfDay(block.startMin)} – ${formatMinuteOfDay(block.endMin)}`}
                      onSelect={choose}
                    />
                  ))}
                {agenda.length === 0 && (
                  <p className="px-1 text-[13px] text-text-faint">Nothing planned for today.</p>
                )}
              </Group>

              {recentTasks.length > 0 && (
                <Group title="Recent">
                  {recentTasks.map((task) => (
                    <TaskOption
                      key={task.id}
                      task={task}
                      area={task.areaId ? (areaById.get(task.areaId) ?? null) : null}
                      onSelect={choose}
                    />
                  ))}
                </Group>
              )}

              {tracking.running && (
                <div className="flex justify-between border-t border-border pt-5">
                  <Button variant="ghost" onClick={() => void run(null)} disabled={busy}>
                    Take a break — stop tracking
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Modal>
  )
}

// ------------------------------------------------------------------- pieces

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 px-1 text-[12px] font-medium tracking-wide text-text-dim uppercase">
        {title}
      </h3>
      <div className="flex flex-col gap-1">{children}</div>
    </section>
  )
}

function AreaBadge({ area }: { area: Area | null }) {
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
}

function TaskOption({
  task,
  area,
  hint,
  onSelect
}: {
  task: Task
  area: Area | null
  hint?: string
  onSelect: (task: Task) => void
}) {
  return (
    <button
      onClick={() => onSelect(task)}
      className="flex w-full items-center gap-3 rounded-[10px] px-4 py-3 text-left transition-colors hover:bg-card-hover"
    >
      <PriorityDot priority={task.priority} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] text-text">{task.title}</div>
        <div className="mt-0.5 flex items-center gap-2 text-[12px] text-text-dim">
          {task.projectName && <span className="truncate">{task.projectName}</span>}
          <AreaBadge area={area} />
        </div>
      </div>
      {hint && <span className="shrink-0 font-mono text-[12px] text-text-dim">{hint}</span>}
      <span className="shrink-0 text-text-faint">
        <PlayIcon size={13} />
      </span>
    </button>
  )
}

function CurrentTask({
  title,
  project,
  area,
  elapsedSec,
  action,
  onAction,
  blockReason,
  onBlockReason
}: {
  title: string
  project: string | null
  area: Area | null
  elapsedSec: number
  action: Action
  onAction: (action: Action) => void
  blockReason: string
  onBlockReason: (reason: string) => void
}) {
  const options: Array<{ id: Action; label: string }> = [
    { id: 'switch', label: 'Switch' },
    { id: 'complete', label: 'Complete & switch' },
    { id: 'block', label: 'Block & switch' }
  ]

  return (
    <div className="rounded-[12px] border border-accent/30 bg-rail-active p-5">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="mb-1 text-[12px] tracking-wide text-accent uppercase">Currently tracking</p>
          <p className="truncate text-[16px] font-medium text-text">{title}</p>
          <div className="mt-1 flex items-center gap-2 text-[12px] text-text-dim">
            {project && <span className="truncate">{project}</span>}
            <AreaBadge area={area} />
          </div>
        </div>
        <span className="flex shrink-0 items-center gap-2 font-mono text-[15px] text-accent">
          <ClockIcon size={14} />
          {formatDuration(Math.floor(elapsedSec / 60))}
        </span>
      </div>

      <div className="flex gap-2">
        {options.map((option) => (
          <button
            key={option.id}
            onClick={() => onAction(option.id)}
            className={`flex-1 rounded-[8px] border py-2 text-[12px] transition-colors ${
              action === option.id
                ? 'border-accent/50 bg-card text-text'
                : 'border-border text-text-dim hover:text-text'
            }`}
          >
            {option.id === 'complete' && action === option.id && (
              <CheckIcon size={11} className="mr-1 inline" />
            )}
            {option.label}
          </button>
        ))}
      </div>

      {action === 'block' && (
        <input
          value={blockReason}
          onChange={(event) => onBlockReason(event.target.value)}
          placeholder="Why is it blocked?"
          className="mt-3 w-full rounded-[8px] border border-border bg-bg px-3 py-2 text-[13px] text-text outline-none focus:border-accent"
        />
      )}
    </div>
  )
}

/**
 * Moving off internship hours is a decision, not a side effect.
 *
 * The organization is named because the confusing case is the one where it does not change:
 * the same employer, the same project even, and yet the next hour does not count toward the
 * internship. Saying "Work for Maasarend" makes that explicit instead of leaving you to
 * infer it from a colour.
 */
function LeaveStageConfirm({
  task,
  fromArea,
  toArea,
  toOrganization,
  onCancel,
  onConfirm,
  busy
}: {
  task: Task
  fromArea: string
  toArea: string
  toOrganization: string | null
  onCancel: () => void
  onConfirm: () => void
  busy: boolean
}) {
  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-[12px] border border-prio-med/40 bg-prio-med/10 p-5">
        <div className="mb-2 flex items-center gap-2 text-prio-med">
          <ShieldIcon size={16} />
          <h3 className="text-[15px] font-semibold">This stops counting internship hours</h3>
        </div>
        <p className="text-[13px] leading-relaxed text-text-dim">
          You are tracking in <strong className="text-text">{fromArea}</strong>, which counts toward
          your internship. <strong className="text-text">{task.title}</strong> is{' '}
          <strong className="text-text">
            {toArea}
            {toOrganization ? ` for ${toOrganization}` : ''}
          </strong>
          , which does not. The time you spend on it stays in your log, but it will not appear in
          your supervisor totals.
        </p>
      </div>

      <div className="flex justify-end gap-3">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Stay on the current task
        </Button>
        <Button variant="primary" onClick={onConfirm} disabled={busy}>
          Switch anyway
        </Button>
      </div>
    </div>
  )
}
