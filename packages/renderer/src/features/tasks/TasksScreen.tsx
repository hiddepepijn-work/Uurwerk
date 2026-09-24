import { useMemo, useState } from 'react'
import type { NewTask, Task } from '@core/contract/types.js'
import { api } from '../../api/client.js'
import { useLiveQuery } from '../../hooks/useLiveQuery.js'
import type { Tracking } from '../../hooks/useTracking.js'
import { Button } from '../../ui/Button.js'
import { CheckIcon, ClockIcon, FilterIcon, PlusIcon, SearchIcon } from '../../ui/icons.js'
import { StatCard } from '../../ui/StatCard.js'
import { CalendarIcon } from '../../ui/icons.js'
import { CurrentQueue } from './CurrentQueue.js'
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
    <div className="flex h-full flex-col p-8">
      <header className="mb-7">
        <h1 className="text-[32px] leading-tight font-semibold">Tasks</h1>
      </header>

      <div className="mb-6 flex items-center gap-3">
        <div className="relative w-[420px]">
          <span className="absolute top-1/2 left-3.5 -translate-y-1/2 text-text-dim">
            <SearchIcon size={16} />
          </span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search tasks..."
            className="w-full rounded-[10px] border border-border bg-card py-2.5 pr-4 pl-10 text-[14px] text-text outline-none placeholder:text-text-faint focus:border-accent"
          />
        </div>

        <Button
          variant="secondary"
          icon={<FilterIcon size={15} />}
          onClick={() => setShowDone((value) => !value)}
        >
          {showDone ? 'Hiding nothing' : 'Open only'}
        </Button>

        <Button
          variant="primary"
          icon={<PlusIcon size={16} />}
          className="ml-auto"
          onClick={() => openEditor(null)}
        >
          New task
        </Button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-2 gap-6">
        <div className="flex min-h-0 flex-col gap-5">
          <CurrentQueue
            tasks={tasks.filter((task) => task.status !== 'done')}
            activeTaskId={tracking.taskId}
            areaById={areaById}
            waitingOnByTask={waitingOnByTask}
            onToggleComplete={(task) => void toggleComplete(task)}
            onStart={(task) => void start(task)}
            onEdit={openEditor}
          />

          <div className="grid shrink-0 grid-cols-3 gap-4">
            <StatCard icon={<ClockIcon size={16} />} label="Open" value={String(open.length)} sub="tasks" />
            <StatCard
              icon={<CalendarIcon size={16} />}
              label="Due today"
              value={String(dueToday.length)}
              sub="tasks"
            />
            <StatCard icon={<CheckIcon size={16} />} label="Completed" value={String(done.length)} sub="tasks" />
          </div>
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
