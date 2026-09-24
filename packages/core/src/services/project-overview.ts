/**
 * One project, read in the order the work has to happen.
 *
 * The task list sorts by priority and then by creation, which is the right answer to "what
 * matters most" and the wrong one to "what can I do next" — a chain of eight chapters
 * appears there as eight equally available tasks, seven of which cannot be started. The
 * dependency edges hold that information and nothing has ever shown it.
 *
 * So this orders by dependency first and marks each row with what it is waiting for, what is
 * waiting on it, and when it is actually scheduled. Three questions, one screen: what is
 * where, what can be picked up now, and when each piece is meant to happen.
 *
 * Nothing here is stored. Every figure is derived from tasks, dependencies, time segments
 * and accepted plans, so this screen can never disagree with the planner or the report.
 */

import type {
  IsoDate,
  ProjectOverview,
  ProjectTaskRow,
  Task,
  TaskReadiness
} from '../contract/types.js'
import type { Store } from '../db/index.js'
import { DependencyGraph } from './planner/dependency-graph.js'

export class ProjectOverviewService {
  constructor(private readonly store: Store) {}

  overview(projectId: string, today: IsoDate): ProjectOverview {
    const project = this.store.projects.list().find((entry) => entry.id === projectId)
    if (!project) throw new Error(`Project not found: ${projectId}`)

    const tasks = this.store.tasks.list({ projectId })
    const graph = new DependencyGraph(this.store.tasks.list(), this.store.dependencies.all())

    // Dependency order first. Within that the topological sort keeps the incoming order,
    // which is priority then creation — so the ranking still decides between two tasks that
    // are equally free to start.
    const ordered = graph.inDependencyOrder(tasks)
    const orderOf = new Map(ordered.map((task, index) => [task.id, index + 1]))

    const workTypes = new Map(this.store.workTypes.list(true).map((type) => [type.id, type.name]))
    const planned = this.store.plans.plannedSpanByTask()
    const titles = new Map(this.store.tasks.list().map((task) => [task.id, task.title]))

    // Every edge once, so "what waits on this" costs no more than "what does this wait on".
    const dependants = new Map<string, string[]>()
    for (const edge of this.store.dependencies.all()) {
      dependants.set(edge.dependsOnTaskId, [
        ...(dependants.get(edge.dependsOnTaskId) ?? []),
        edge.taskId
      ])
    }

    const rows: ProjectTaskRow[] = ordered.map((task) => {
      const blockers = graph.blockedBy(task.id)
      const span = planned.get(task.id)

      return {
        taskId: task.id,
        title: task.title,
        order: orderOf.get(task.id) ?? 0,
        readiness: readinessOf(task, blockers.length),
        priority: task.priority,
        status: task.status,
        workTypeName: task.workTypeId ? (workTypes.get(task.workTypeId) ?? null) : null,
        dueDate: task.dueDate,
        estimateMin: task.estimateMin,
        loggedMin: task.loggedMin,
        waitingOn: blockers.map((edge) => ({
          taskId: edge.dependsOnTaskId,
          title: titles.get(edge.dependsOnTaskId) ?? 'Unknown task',
          order: orderOf.get(edge.dependsOnTaskId) ?? 0
        })),
        // Only what is still unfinished: a dependant you already completed is not a cost of
        // leaving this one undone.
        blocks: (dependants.get(task.id) ?? [])
          .filter((id) => !isSettled(this.store.tasks.get(id)?.status))
          .map((id) => ({
            taskId: id,
            title: titles.get(id) ?? 'Unknown task',
            order: orderOf.get(id) ?? 0
          })),
        plannedFrom: span?.from ?? null,
        plannedTo: span?.to ?? null,
        plannedMin: span?.minutes ?? 0,
        blockedReason: task.blockedReason
      }
    })

    const open = rows.filter((row) => row.readiness !== 'done')

    return {
      project,
      areaName: project.areaId ? (this.store.areas.get(project.areaId)?.name ?? null) : null,
      organizationName: project.organizationId
        ? (this.store.organizations.list(true).find((org) => org.id === project.organizationId)
            ?.name ?? null)
        : null,
      tasks: rows,
      taskCount: rows.length,
      doneCount: rows.filter((row) => row.readiness === 'done').length,
      estimateMin: rows.reduce((sum, row) => sum + (row.estimateMin ?? 0), 0),
      loggedMin: rows.reduce((sum, row) => sum + row.loggedMin, 0),
      // Per task, never as one subtraction: an overrun on one task must not cancel out
      // remaining work on another and report the project as closer to done than it is.
      remainingMin: open.reduce(
        (sum, row) => sum + Math.max(0, (row.estimateMin ?? 0) - row.loggedMin),
        0
      ),
      nextTaskId: open.find((row) => row.readiness === 'ready')?.taskId ?? null,
      finalDueDate: open.reduce<IsoDate | null>(
        (latest, row) => (row.dueDate && (!latest || row.dueDate > latest) ? row.dueDate : latest),
        null
      ),
      overdueCount: open.filter((row) => row.dueDate !== null && row.dueDate < today).length,
      // Worth counting separately from "not started": work with an estimate and no place in
      // any accepted plan is work nobody has found the hours for yet.
      unplannedCount: open.filter((row) => row.estimateMin !== null && row.plannedMin === 0).length
    }
  }
}

const isSettled = (status: Task['status'] | undefined): boolean =>
  status === undefined || status === 'done' || status === 'archived'

function readinessOf(task: Task, blockerCount: number): TaskReadiness {
  if (task.status === 'done' || task.status === 'archived') return 'done'
  // A task you marked blocked yourself outranks the graph: you know something it does not.
  if (task.status === 'blocked') return 'blocked'
  return blockerCount > 0 ? 'waiting' : 'ready'
}
