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
  WorkType
} from '@core/contract/types.js'
import { Button } from '../../ui/Button.js'
import { DateField } from '../../ui/DateField.js'
import { Modal } from '../../ui/Modal.js'
import { PriorityDot, PRIORITY_LABEL } from '../../ui/PriorityDot.js'

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
        mustDoDate: mustDo || null
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
    'w-full rounded-[10px] border border-border bg-bg px-3.5 py-2.5 text-[14px] text-text outline-none focus:border-accent'

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
          <div className="flex gap-3">
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
      <div className="flex flex-col gap-5">
        {problem && (
          <div className="rounded-[10px] border border-prio-med/40 bg-prio-med/10 px-4 py-3 text-[13px] text-prio-med">
            {problem}
          </div>
        )}

        <label className="flex flex-col gap-2">
          <span className="text-[13px] text-text-dim">Title</span>
          <input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && void submit()}
            placeholder="What needs doing?"
            className={field}
          />
        </label>

        <div className="flex flex-col gap-2">
          <span className="text-[13px] text-text-dim">Area</span>
          <div className="flex gap-2">
            {areas.map((area) => (
              <button
                key={area.id}
                onClick={() => setAreaId(area.id)}
                className={`flex-1 rounded-[10px] border py-2.5 text-[13px] transition-colors ${
                  areaId === area.id
                    ? 'border-accent/50 bg-rail-active text-text'
                    : 'border-border bg-bg text-text-dim hover:bg-card-hover'
                }`}
              >
                {area.name}
              </button>
            ))}
          </div>
          <p className="text-[12px] text-text-faint">
            {selectedArea?.countsAsStageHours
              ? 'Time on this task counts toward your internship hours.'
              : 'Time on this task is tracked, but does not count toward internship hours.'}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 wide:grid-cols-2">
          <label className="flex flex-col gap-2">
            <span className="text-[13px] text-text-dim">Project</span>
            <select
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              className={field}
            >
              <option value="">No project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <span className="text-[12px] text-text-faint">
              The project decides who the work is for. It does not decide the area.
            </span>
          </label>

          {/* Independent of both: research is research, whether it is internship work,
              other work for the same organization, or a course. */}
          <label className="flex flex-col gap-2">
            <span className="text-[13px] text-text-dim">Work type</span>
            <select
              value={workTypeId}
              onChange={(event) => setWorkTypeId(event.target.value)}
              className={field}
            >
              <option value="">Unlabelled</option>
              {workTypes.map((workType) => (
                <option key={workType.id} value={workType.id}>
                  {workType.name}
                </option>
              ))}
            </select>
            <span className="text-[12px] text-text-faint">
              What kind of activity this is, across every area.
            </span>
          </label>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-[13px] text-text-dim">Priority</span>
          <div className="flex gap-2">
            {PRIORITIES.map((option) => (
              <button
                key={option}
                onClick={() => setPriority(option)}
                className={`flex flex-1 items-center justify-center gap-2 rounded-[10px] border py-2.5 text-[13px] transition-colors ${
                  priority === option
                    ? 'border-accent/50 bg-rail-active text-text'
                    : 'border-border bg-bg text-text-dim hover:bg-card-hover'
                }`}
              >
                <PriorityDot priority={option} />
                {PRIORITY_LABEL[option]}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 wide:grid-cols-2">
          <label className="flex flex-col gap-2">
            <span className="text-[13px] text-text-dim">Estimate (hours)</span>
            <input
              type="number"
              min="0"
              step="0.25"
              value={estimate}
              onChange={(event) => setEstimate(event.target.value)}
              placeholder="No estimate"
              className={field}
            />
          </label>
          <div className="flex flex-col gap-2">
            <span className="text-[13px] text-text-dim">Due date</span>
            <DateField value={due} onChange={setDue} placeholder="No deadline" />
          </div>
        </div>

        {/* Both of these are constraints the planner obeys before it looks at any score:
            it will not place work before it can start, and a must-do day outranks the
            ordinary ranking on that day. */}
        <div className="grid grid-cols-1 gap-4 wide:grid-cols-2">
          <div className="flex flex-col gap-2">
            <span className="text-[13px] text-text-dim">Cannot start before</span>
            <DateField value={earliestStart} onChange={setEarliestStart} placeholder="Any time" />
            <span className="text-[12px] text-text-faint">
              Waiting on data or someone else? The planner leaves it alone until then.
            </span>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-[13px] text-text-dim">Must be done on</span>
            <DateField value={mustDo} onChange={setMustDo} placeholder="Not pinned" />
            <span className="text-[12px] text-text-faint">
              Pins it to that day, above everything the ranking would otherwise pick.
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-[13px] text-text-dim">Waits for</span>
          <p className="text-[12px] text-text-faint">
            A hard prerequisite keeps this task out of the plan entirely until it is finished.
            Preferred is only an ordering hint.
          </p>

          {candidates.length === 0 ? (
            <p className="text-[13px] text-text-faint">No other tasks to wait for yet.</p>
          ) : (
            <div className="max-h-48 overflow-y-auto rounded-[10px] border border-border">
              {candidates.map((candidate) => {
                const edge = edges.find((entry) => entry.dependsOnTaskId === candidate.id)
                const settled =
                  statusById.get(candidate.id) === 'done' ||
                  statusById.get(candidate.id) === 'archived'

                return (
                  <div
                    key={candidate.id}
                    className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0"
                  >
                    <input
                      type="checkbox"
                      checked={Boolean(edge)}
                      onChange={() => toggleDependency(candidate.id)}
                      className="accent-accent"
                    />
                    <span
                      className={`min-w-0 flex-1 truncate text-[13px] ${
                        settled ? 'text-text-faint line-through' : 'text-text'
                      }`}
                    >
                      {candidate.title}
                    </span>
                    {edge && (
                      <select
                        value={edge.type}
                        onChange={(event) =>
                          setDependencyType(candidate.id, event.target.value as DependencyType)
                        }
                        className="rounded-[6px] border border-border bg-bg px-2 py-1 text-[12px] text-text-dim outline-none focus:border-accent"
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
