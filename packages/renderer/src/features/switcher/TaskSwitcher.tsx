import { useEffect, useMemo, useRef, useState } from 'react'
import type { Area, PlannedBlock, Task } from '@core/contract/types.js'
import { api } from '../../api/client.js'
import { useLiveQuery } from '../../hooks/useLiveQuery.js'
import { useThisWeek, useToday } from '../../hooks/useToday.js'
import type { Tracking } from '../../hooks/useTracking.js'
import { Button } from '../../ui/Button.js'
import { Modal } from '../../ui/Modal.js'
import { PriorityDot } from '../../ui/PriorityDot.js'
import { CheckIcon, PlayIcon, PlusIcon, SearchIcon, ShieldIcon } from '../../ui/icons.js'
import { colorFor } from '../agenda/agenda-model.js'
import { AreaChip } from '../tasks/AreaChip.js'
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
        <div className="flex flex-col gap-4 wide:gap-3.5">
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

          <label className="flex h-12 items-center gap-2.5 rounded-input bg-input px-3.5 text-text-faint focus-within:shadow-[inset_0_0_0_1.5px_var(--color-accent)] wide:rounded-button">
            <SearchIcon size={18} />
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
              aria-label="Search tasks"
              className="min-w-0 flex-1 bg-transparent text-[14px] font-medium text-text outline-none focus-visible:outline-none wide:text-[15px]"
            />
          </label>

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
                className="flex w-full items-center gap-3 rounded-button border-[1.5px] border-dashed border-border-strong px-4 py-3 text-left transition-colors hover:bg-input disabled:opacity-40"
              >
                <span className="text-accent-soft">
                  <PlusIcon size={16} />
                </span>
                <span className="text-[15px] font-bold text-text">
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
                    highlight
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
                <div className="flex justify-center wide:justify-end wide:border-t wide:border-border wide:pt-3">
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
      <h3 className="label-caps px-1 pb-1.5 wide:pb-1">{title}</h3>
      <div className="flex flex-col gap-1.5 wide:gap-1">{children}</div>
    </section>
  )
}

function TaskOption({
  task,
  area,
  hint,
  highlight = false,
  onSelect
}: {
  task: Task
  area: Area | null
  hint?: string
  /** The one the plan says is next: drawn a step forward. */
  highlight?: boolean
  onSelect: (task: Task) => void
}) {
  return (
    // Phone: each option its own card on the sheet. Wide: flat single-line rows in the dialog.
    <button
      onClick={() => onSelect(task)}
      className={`flex w-full items-center gap-3 rounded-[18px] bg-card px-3.5 py-3 text-left transition-colors
        wide:h-[46px] wide:rounded-button wide:px-3 wide:py-0 wide:hover:bg-input
        ${highlight ? 'wide:bg-input' : 'wide:bg-transparent'}`}
    >
      <PriorityDot priority={task.priority} />
      <div className="flex min-w-0 flex-1 flex-col gap-1 wide:flex-row wide:items-center wide:gap-2.5">
        <div className="truncate text-[15px] leading-tight font-bold text-text wide:font-semibold">{task.title}</div>
        <div className="flex min-w-0 items-center gap-1.5 wide:gap-2.5">
          {task.projectName && (
            <span className="truncate text-[13px] font-semibold text-text-dim wide:font-medium wide:text-text-faint">
              {task.projectName}
            </span>
          )}
          <AreaChip area={area} />
        </div>
      </div>
      {hint && (
        <span className="shrink-0 font-mono text-[13px] font-bold whitespace-nowrap text-text-dim">{hint}</span>
      )}
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full wide:h-[30px] wide:w-[30px] wide:rounded-[10px] ${
          highlight ? 'bg-accent text-accent-ink' : 'bg-input text-accent-soft wide:text-text-dim'
        }`}
      >
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

  // Phone: the quiet "running" tint. Wide: a solid block in the area's own colour, like the
  // agenda draws a running task.
  const color = colorFor(area?.id ?? null)
  const areaVars = { '--area-fill': color.fill, '--area-ink': color.ink } as React.CSSProperties

  return (
    <div
      style={areaVars}
      className="flex flex-col gap-3 rounded-modal bg-rail-active p-4 wide:rounded-card wide:bg-(--area-fill) wide:px-[18px] wide:text-(--area-ink)"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-[12px] font-bold tracking-[1px] text-accent-soft uppercase wide:text-(--area-ink)">
            Currently tracking
          </p>
          <p className="truncate font-display text-[24px] leading-[1.1] font-bold tracking-[-0.3px] text-text wide:text-(--area-ink)">
            {title}
          </p>
          <div className="flex items-center gap-2 text-[14px] font-semibold text-text-dim wide:text-[13px] wide:text-(--area-ink)">
            {project && <span className="truncate">{project}</span>}
            {area && (
              <>
                <span className="wide:hidden">
                  <AreaChip area={area} />
                </span>
                <span className="hidden wide:inline">
                  <AreaChip area={area} onFill />
                </span>
              </>
            )}
          </div>
        </div>
        <span className="shrink-0 font-display text-[22px] font-bold text-accent-soft tabular-nums wide:text-[30px] wide:text-(--area-ink)">
          {formatDuration(Math.floor(elapsedSec / 60))}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-1.5 wide:gap-2">
        {options.map((option) => (
          <button
            key={option.id}
            onClick={() => onAction(option.id)}
            className={`flex h-11 items-center justify-center rounded-button px-1.5 text-[13px] leading-[1.15] font-bold transition-colors wide:h-[42px] wide:text-[14px] ${
              action === option.id
                ? 'bg-accent text-accent-ink wide:bg-(--area-ink) wide:text-(--area-fill)'
                : 'bg-bg/55 text-text hover:bg-bg/80 wide:bg-black/15 wide:text-(--area-ink) wide:hover:bg-black/25'
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
          className="h-11 w-full rounded-input bg-bg/55 px-3.5 text-[14px] font-medium text-text outline-none wide:bg-black/15 wide:text-(--area-ink) wide:placeholder:text-(--area-ink)/60"
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
      <div className="rounded-card bg-warn-soft p-5">
        <div className="mb-2 flex items-center gap-2 text-warn">
          <ShieldIcon size={16} />
          <h3 className="text-[15px] font-bold">This stops counting internship hours</h3>
        </div>
        <p className="text-[14px] leading-relaxed text-text-dim">
          You are tracking in <strong className="font-bold text-text">{fromArea}</strong>, which counts toward
          your internship. <strong className="font-bold text-text">{task.title}</strong> is{' '}
          <strong className="font-bold text-text">
            {toArea}
            {toOrganization ? ` for ${toOrganization}` : ''}
          </strong>
          , which does not. The time you spend on it stays in your log, but it will not appear in
          your supervisor totals.
        </p>
      </div>

      <div className="flex flex-wrap justify-end gap-2">
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
