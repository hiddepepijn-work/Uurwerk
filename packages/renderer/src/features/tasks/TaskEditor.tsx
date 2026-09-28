import { useEffect, useMemo, useState } from 'react'
import type {
  Area,
  DependencyType,
  NewTask,
  Priority,
  Project,
  Task,
  TaskDependency,
  TaskPatch,
  WorkType, FocusMode } from '@core/contract/types.js'
import { Button } from '../../ui/Button.js'
import { DateField } from '../../ui/DateField.js'
import { Modal } from '../../ui/Modal.js'
import { PriorityDot, PRIORITY_LABEL } from '../../ui/PriorityDot.js'
import { areaFill, colorFor } from '../agenda/agenda-model.js'

const PRIORITIES: Priority[] = ['high', 'medium', 'low']

export interface DependencyEdit {
  dependsOnTaskId: string
  type: DependencyType
}

interface Props {
  open: boolean
  projects: Project[]
  areas: Area[]
  /** What kind of activity this is — orthogonal to the area and to the organization. */
  workTypes: WorkType[]
  /** Preselected when creating; comes from settings. */
  defaultAreaId: string
  /** Present when editing an existing task, absent when creating one. */
  task?: Task | null
  /** Everything that could be a prerequisite. The task being edited is filtered out. */
  allTasks: Task[]
  /** What this task already waits for. */
  dependencies: TaskDependency[]
  onClose: () => void
  /** Returns the created task, so its dependencies can be saved in the same submit. */
  onCreate: (task: NewTask) => Promise<Task>
  onUpdate?: (id: string, patch: TaskPatch) => Promise<void>
  onDelete?: (id: string) => Promise<void>
  /** Throws on a cycle; the message names the chain and is shown in the dialog. */
  onSaveDependencies?: (taskId: string, dependencies: DependencyEdit[]) => Promise<void>
}

/**
 * Create and edit a task.
 *
 * The area picker is the important field: it decides whether the time you log against
 * this task counts toward your internship hours, and whether it can ever be shared with
 * your supervisor. It is shown first for that reason, not last.
 */
export function TaskEditor({
  open,
  projects,
  areas,
  workTypes,
  defaultAreaId,
  task,
  allTasks,
  dependencies,
  onClose,
  onCreate,
  onUpdate,
  onDelete,
  onSaveDependencies
}: Props) {
  const editing = Boolean(task)

  const [title, setTitle] = useState('')
  const [projectId, setProjectId] = useState('')
  const [areaId, setAreaId] = useState(defaultAreaId)
  const [workTypeId, setWorkTypeId] = useState('')
  const [priority, setPriority] = useState<Priority>('medium')
  const [estimate, setEstimate] = useState('')
  const [due, setDue] = useState('')
  const [earliestStart, setEarliestStart] = useState('')
  const [mustDo, setMustDo] = useState('')
  const [notes, setNotes] = useState('')
  const [focusMode, setFocusMode] = useState<FocusMode>('auto')
  const [edges, setEdges] = useState<DependencyEdit[]>([])
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setTitle(task?.title ?? '')
    setProjectId(task?.projectId ?? '')
    setAreaId(task?.areaId ?? defaultAreaId)
    setWorkTypeId(task?.workTypeId ?? '')
    setPriority(task?.priority ?? 'medium')
    // Stored in minutes, edited in hours; blank stays blank because "unknown" is not zero.
    setEstimate(task?.estimateMin ? String(task.estimateMin / 60) : '')
    setDue(task?.dueDate ?? '')
    setEarliestStart(task?.earliestStartDate ?? '')
    setMustDo(task?.mustDoDate ?? '')
    setNotes(task?.notes ?? '')
    setFocusMode(task?.focusMode ?? 'auto')
    setEdges(
      dependencies.map((dependency) => ({
        dependsOnTaskId: dependency.dependsOnTaskId,
        type: dependency.type
      }))
    )
    setProblem(null)
    // `dependencies` arrives with the task it belongs to, so the task is the real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task, defaultAreaId])

  /** Anything but this task; a task cannot wait for itself. */
  const candidates = useMemo(
    () =>
      allTasks.filter(
        (candidate) => candidate.id !== task?.id && candidate.status !== 'archived'
      ),
    [allTasks, task?.id]
  )

  const statusById = useMemo(
    () => new Map(allTasks.map((entry) => [entry.id, entry.status])),
    [allTasks]
  )

  const toggleDependency = (dependsOnTaskId: string): void => {
    setEdges((current) =>
      current.some((edge) => edge.dependsOnTaskId === dependsOnTaskId)
        ? current.filter((edge) => edge.dependsOnTaskId !== dependsOnTaskId)
        : [...current, { dependsOnTaskId, type: 'hard' }]
    )
  }

  const setDependencyType = (dependsOnTaskId: string, type: DependencyType): void => {
    setEdges((current) =>
      current.map((edge) => (edge.dependsOnTaskId === dependsOnTaskId ? { ...edge, type } : edge))
    )
  }

  const submit = async (): Promise<void> => {
    if (!title.trim()) return
    setBusy(true)
    setProblem(null)
    try {
      const fields = {
        title: title.trim(),
        projectId: projectId || null,
        areaId: areaId || null,
        workTypeId: workTypeId || null,
        priority,
        estimateMin: estimate ? Math.round(Number(estimate) * 60) : null,
        dueDate: due || null,
        earliestStartDate: earliestStart || null,
        mustDoDate: mustDo || null,
        notes: notes.trim() || null,
        focusMode
      }

      // The dependency write can be rejected for a cycle, so it goes last: a refused edge
      // must not leave the rest of the edit unsaved.
      const id = task && onUpdate ? (await onUpdate(task.id, fields), task.id) : (await onCreate(fields)).id
      if (onSaveDependencies) await onSaveDependencies(id, edges)

      onClose()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const field =
    'h-11 w-full rounded-input bg-input px-3.5 text-[15px] font-semibold text-text outline-none'
  const select =
    'h-[46px] w-full rounded-input bg-input px-3 text-[15px] font-semibold text-text outline-none wide:h-11 wide:text-[14px]'
  const label = 'label-caps tracking-[0.8px]'
  const help = 'text-[13px] leading-snug text-text-faint wide:text-[12px]'
  const group = 'flex flex-col gap-2 wide:gap-1.5'

  const selectedArea = areas.find((area) => area.id === areaId) ?? null

  return (
    <Modal
      open={open}
      title={editing ? 'Edit task' : 'New task'}
      onClose={onClose}
      width={560}
      footer={
        <>
          {editing && onDelete ? (
            <Button
              variant="danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await onDelete(task!.id)
                  onClose()
                } finally {
                  setBusy(false)
                }
              }}
            >
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void submit()}
              disabled={busy || !title.trim()}
            >
              {editing ? 'Save changes' : 'Create task'}
            </Button>
          </div>
        </>
      }
    >
      <div className="flex flex-col gap-5 wide:gap-4">
        {problem && (
          <div className="rounded-input bg-warn-soft px-4 py-3 text-[13px] font-semibold text-warn">
            {problem}
          </div>
        )}

        <label className={group}>
          <span className={label}>Title</span>
          <input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && void submit()}
            placeholder="What needs doing?"
            className="h-12 w-full rounded-input bg-input px-3.5 text-[16px] font-semibold text-text outline-none wide:h-11 wide:text-[15px] wide:font-bold"
          />
        </label>

        <div className={group}>
          <span className={label}>Area</span>
          <div className="flex gap-1.5 wide:gap-2">
            {areas.map((area) => {
              const selected = areaId === area.id
              const color = colorFor(area.id)
              return (
                <button
                  key={area.id}
                  onClick={() => setAreaId(area.id)}
                  className={`flex h-[42px] min-w-0 flex-1 items-center justify-center gap-2 rounded-button border-[1.5px] text-[14px] font-bold transition-colors wide:h-10 ${
                    selected ? '' : 'border-transparent bg-input text-text-dim hover:bg-secondary-hover'
                  }`}
                  style={
                    selected
                      ? { background: color.tint, color: color.soft, borderColor: areaFill(area) }
                      : undefined
                  }
                >
                  <span
                    className="hidden h-2 w-2 shrink-0 rounded-full wide:inline-block"
                    style={{ background: areaFill(area) }}
                  />
                  <span className="truncate">{area.name}</span>
                </button>
              )
            })}
          </div>
          <p className={help}>
            {selectedArea?.countsAsStageHours
              ? 'Time on this task counts toward your internship hours.'
              : 'Time on this task is tracked, but does not count toward internship hours.'}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-5 wide:grid-cols-2 wide:gap-3">
          <label className={group}>
            <span className={label}>Project</span>
            <select
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              className={select}
            >
              <option value="">No project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <span className={help}>
              The project decides who the work is for. It does not decide the area.
            </span>
          </label>

          {/* Independent of both: research is research, whether it is internship work,
              other work for the same organization, or a course. */}
          <label className={group}>
            <span className={label}>Work type</span>
            <select
              value={workTypeId}
              onChange={(event) => setWorkTypeId(event.target.value)}
              className={select}
            >
              <option value="">Unlabelled</option>
              {workTypes.map((workType) => (
                <option key={workType.id} value={workType.id}>
                  {workType.name}
                </option>
              ))}
            </select>
            <span className={help}>
              What kind of activity this is, across every area.
            </span>
          </label>
        </div>

        <div className={group}>
          <span className={label}>Priority</span>
          <div className="grid grid-cols-3 gap-1.5 wide:gap-2">
            {PRIORITIES.map((option) => (
              <button
                key={option}
                onClick={() => setPriority(option)}
                className={`flex h-11 items-center justify-center gap-2 rounded-button border-[1.5px] text-[15px] font-bold transition-colors wide:h-10 wide:text-[14px] ${
                  priority === option
                    ? PRIORITY_SELECTED[option]
                    : 'border-transparent bg-input text-text-dim hover:bg-secondary-hover'
                }`}
              >
                <PriorityDot priority={option} />
                {PRIORITY_LABEL[option]}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-5 wide:grid-cols-2 wide:gap-3">
          <label className={group}>
            <span className={label}>Estimate (hours)</span>
            <input
              type="number"
              min="0"
              step="0.25"
              value={estimate}
              onChange={(event) => setEstimate(event.target.value)}
              placeholder="No estimate"
              className={`${field} tabular-nums`}
            />
          </label>
          <div className={group}>
            <span className={label}>Due date</span>
            <DateField value={due} onChange={setDue} placeholder="No deadline" />
          </div>
        </div>

        {/* Both of these are constraints the planner obeys before it looks at any score:
            it will not place work before it can start, and a must-do day outranks the
            ordinary ranking on that day. */}
        <div className="grid grid-cols-1 gap-5 wide:grid-cols-2 wide:gap-3">
          <div className={group}>
            <span className={label}>Cannot start before</span>
            <DateField value={earliestStart} onChange={setEarliestStart} placeholder="Any time" />
            <span className={help}>
              Waiting on data or someone else? The planner leaves it alone until then.
            </span>
          </div>
          <div className={group}>
            <span className={label}>Must be done on</span>
            <DateField value={mustDo} onChange={setMustDo} placeholder="Not pinned" />
            <span className={help}>
              Pins it to that day, above everything the ranking would otherwise pick.
            </span>
          </div>
        </div>

        <label className={group}>
          <span className={label}>Focus</span>
          <select
            value={focusMode}
            onChange={(event) => setFocusMode(event.target.value as FocusMode)}
            className={select}
          >
            <option value="auto">Automatic — stage always, private from 30 min</option>
            <option value="always">Always — lock down until done</option>
            <option value="never">Never</option>
          </select>
          <span className={help}>
            While a focus task is on, the phone allows only the essentials and the laptop closes blocked apps — until it is done.
          </span>
        </label>

        <label className={group}>
          <span className={label}>Notes</span>
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={3}
            placeholder="What counts as done, what you need, particulars"
            className="w-full resize-y rounded-input bg-input px-3.5 py-3 text-[14px] leading-normal font-medium text-text outline-none"
          />
          <span className={help}>Jarvis reads these when it reminds you or asks how it went.</span>
        </label>

        <div className={group}>
          <span className={label}>Waits for</span>
          <p className={help}>
            A hard prerequisite keeps this task out of the plan entirely until it is finished.
            Preferred is only an ordering hint.
          </p>

          {candidates.length === 0 ? (
            <p className="text-[13px] text-text-faint">No other tasks to wait for yet.</p>
          ) : (
            <div className="max-h-48 overflow-y-auto rounded-button border border-border px-1.5 py-1">
              {candidates.map((candidate) => {
                const edge = edges.find((entry) => entry.dependsOnTaskId === candidate.id)
                const settled =
                  statusById.get(candidate.id) === 'done' ||
                  statusById.get(candidate.id) === 'archived'

                return (
                  <div key={candidate.id} className="flex min-h-10 items-center gap-2.5 px-1.5">
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
                      <input
                        type="checkbox"
                        checked={Boolean(edge)}
                        onChange={() => toggleDependency(candidate.id)}
                        className="peer sr-only"
                      />
                      {/* The real checkbox is visually hidden; this box draws it and carries its focus ring. */}
                      <span
                        aria-hidden="true"
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] text-accent-ink peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent ${
                          edge ? 'bg-accent' : 'border-[1.5px] border-border-strong'
                        }`}
                      >
                        {edge && (
                          <svg
                            width="12"
                            height="12"
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
                      </span>
                      <span
                        className={`min-w-0 flex-1 truncate text-[14px] font-semibold ${
                          settled ? 'text-text-faint line-through' : edge ? 'text-text' : 'text-text-dim'
                        }`}
                      >
                        {candidate.title}
                      </span>
                    </label>
                    {edge && (
                      <select
                        value={edge.type}
                        onChange={(event) =>
                          setDependencyType(candidate.id, event.target.value as DependencyType)
                        }
                        aria-label="Dependency strength"
                        className="h-[30px] rounded-[10px] bg-input px-2 text-[13px] font-bold text-text outline-none"
                      >
                        <option value="hard">Hard</option>
                        <option value="preferred">Preferred</option>
                      </select>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

/** A chosen priority wears its own colour: tint behind, the signal colour as text and edge. */
const PRIORITY_SELECTED: Record<Priority, string> = {
  high: 'border-prio-high bg-danger-soft text-danger-text',
  medium: 'border-prio-med bg-warn-soft text-warn',
  low: 'border-prio-low bg-input text-text'
}
