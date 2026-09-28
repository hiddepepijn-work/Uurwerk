import { useMemo, useState } from 'react'
import type { NewTask, Task } from '@core/contract/types.js'
import { api } from '../../api/client.js'
import { useLiveQuery } from '../../hooks/useLiveQuery.js'
import type { Tracking } from '../../hooks/useTracking.js'
import { Button } from '../../ui/Button.js'
import { FilterIcon, PlusIcon, SearchIcon } from '../../ui/icons.js'
import { useCountUp } from '../../ui/useCountUp.js'
import { CurrentQueue } from './CurrentQueue.js'
import { IdeasPanel } from './IdeasPanel.js'
import { PriorityView } from './PriorityView.js'
import { TaskEditor } from './TaskEditor.js'

export function TasksScreen({ tracking }: { tracking: Tracking }) {
  const [search, setSearch] = useState('')
  const [showDone, setShowDone] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  /** null while creating, a task while editing one. */
  const [editing, setEditing] = useState<Task | null>(null)

  const { data: allTasks } = useLiveQuery((client) => client.tasks.list(), ['tasks'], [])
  const { data: projects } = useLiveQuery((client) => client.projects.list(), ['settings'], [])
  const { data: areas } = useLiveQuery((client) => client.areas.list(), ['settings'], [])
  const { data: settings } = useLiveQuery((client) => client.settings.get(), ['settings'], [])
  const { data: dependencies } = useLiveQuery(
    (client) => client.dependencies.list(),
    ['tasks'],
    []
  )
  const { data: workTypes } = useLiveQuery((client) => client.workTypes.list(), ['settings'], [])

  const areaById = useMemo(
    () => new Map((areas ?? []).map((area) => [area.id, area])),
    [areas]
  )

  /**
   * Unfinished hard prerequisites per task.
   *
   * Only hard ones and only unfinished ones: a preferred edge never keeps a task out of the
   * plan, and a finished prerequisite is not something anyone is still waiting for.
   */
  const waitingOnByTask = useMemo(() => {
    const counts = new Map<string, number>()
    for (const edge of dependencies ?? []) {
      if (edge.type !== 'hard') continue
      if (edge.dependsOnStatus === 'done' || edge.dependsOnStatus === 'archived') continue
      counts.set(edge.taskId, (counts.get(edge.taskId) ?? 0) + 1)
    }
    return counts
  }, [dependencies])

  const editingDependencies = useMemo(
    () => (dependencies ?? []).filter((edge) => edge.taskId === editing?.id),
    [dependencies, editing?.id]
  )

  const tasks = useMemo(() => {
    const list = (allTasks ?? []).filter((task) => showDone || task.status !== 'done')
    if (!search.trim()) return list
    const needle = search.toLowerCase()
    return list.filter(
      (task) =>
        task.title.toLowerCase().includes(needle) ||
        (task.projectName ?? '').toLowerCase().includes(needle)
    )
  }, [allTasks, search, showDone])

  const open = (allTasks ?? []).filter(
    (task) => task.status === 'open' || task.status === 'in_progress' || task.status === 'blocked'
  )
  const done = (allTasks ?? []).filter((task) => task.status === 'done')
  const dueToday = open.filter((task) => task.dueDate === todayIso())

  const toggleComplete = async (task: Task): Promise<void> => {
    await api.tasks.complete(task.id, task.status !== 'done')
  }

  // Switching rather than restarting keeps the current working session continuous.
  const start = async (task: Task): Promise<void> => {
    if (tracking.running) await tracking.switchTask(task.id)
    else await tracking.start(task.id)
  }

  // Returns the created task so the editor can attach its dependencies straight away,
  // rather than making you save, reopen and edit again.
  const create = async (task: NewTask): Promise<Task> => api.tasks.create(task)

  const openEditor = (task: Task | null): void => {
    setEditing(task)
    setEditorOpen(true)
  }

  return (
    <div className="flex flex-col p-4 wide:h-full wide:px-8 wide:py-7">
      {/* Phone: title, search and buttons stacked. Wide: one toolbar row. */}
      <div className="mb-3.5 flex flex-col gap-3.5 wide:mb-[22px] wide:flex-row wide:items-center">
        <header className="wide:mr-[18px]">
          <h1 className="display-title text-[40px] tracking-[-1px]">Tasks</h1>
        </header>

        <label className="flex h-11 w-full items-center gap-2.5 rounded-input bg-input px-3.5 text-text-faint wide:w-[420px]">
          <SearchIcon size={18} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search tasks..."
            aria-label="Search tasks"
            className="min-w-0 flex-1 bg-transparent text-[15px] font-medium text-text outline-none"
          />
        </label>

        <div className="flex gap-2.5 wide:contents">
          <Button
            variant="secondary"
            icon={<FilterIcon size={17} />}
            onClick={() => setShowDone((value) => !value)}
          >
            {showDone ? 'Hiding nothing' : 'Open only'}
          </Button>

          <Button
            variant="primary"
            icon={<PlusIcon size={17} />}
            className="ml-auto"
            onClick={() => openEditor(null)}
          >
            New task
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3.5 wide:min-h-0 wide:flex-1 wide:grid-cols-2 wide:gap-5">
        <div className="flex min-h-0 flex-col gap-3.5">
          <CurrentQueue
            tasks={tasks.filter((task) => task.status !== 'done')}
            activeTaskId={tracking.taskId}
            areaById={areaById}
            waitingOnByTask={waitingOnByTask}
            onToggleComplete={(task) => void toggleComplete(task)}
            onStart={(task) => void start(task)}
            onEdit={openEditor}
          />

          <div className="grid shrink-0 grid-cols-3 gap-2.5 wide:gap-3">
            <CountTile label="Open" value={open.length} />
            <CountTile label="Due today" value={dueToday.length} tone={dueToday.length > 0 ? 'warn' : 'plain'} />
            <CountTile label="Completed" value={done.length} tone="accent" />
          </div>

          <IdeasPanel projects={projects ?? []} />
        </div>

        <PriorityView
          tasks={tasks}
          activeTaskId={tracking.taskId}
          areaById={areaById}
          waitingOnByTask={waitingOnByTask}
          onToggleComplete={(task) => void toggleComplete(task)}
          onStart={(task) => void start(task)}
          onEdit={openEditor}
        />
      </div>

      <TaskEditor
        open={editorOpen}
        projects={projects ?? []}
        areas={areas ?? []}
        workTypes={workTypes ?? []}
        defaultAreaId={settings?.defaultAreaId ?? 'stage'}
        task={editing}
        allTasks={allTasks ?? []}
        dependencies={editingDependencies}
        onClose={() => setEditorOpen(false)}
        onCreate={create}
        onUpdate={async (id, patch) => {
          await api.tasks.update(id, patch)
        }}
        onDelete={async (id) => {
          await api.tasks.remove(id)
        }}
        onSaveDependencies={async (id, edges) => {
          await api.dependencies.set(id, edges)
        }}
      />
    </div>
  )
}

function todayIso(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** A count with a quiet label: the three numbers under the queue. */
function CountTile({
  label,
  value,
  tone = 'plain'
}: {
  label: string
  value: number
  tone?: 'plain' | 'warn' | 'accent'
}) {
  const color = tone === 'warn' ? 'text-warn' : tone === 'accent' ? 'text-accent-soft' : 'text-text'
  const shown = useCountUp(String(value))
  return (
    <div className="flex flex-col gap-1 rounded-card bg-card p-3.5 wide:gap-1.5 wide:p-4">
      <span className="text-[12px] font-bold tracking-[0.6px] text-text-faint wide:text-[13px] wide:tracking-normal wide:text-text-dim">
        {label}
      </span>
      <span className={`display-title text-[30px] tabular-nums leading-[1.05] ${color}`}>{shown}</span>
      <span className="text-[13px] font-semibold text-text-dim wide:font-normal wide:text-text-faint">tasks</span>
    </div>
  )
}
