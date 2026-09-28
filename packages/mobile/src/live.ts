/**
 * The Live Activity on the lock screen: the planned task of this moment, with a countdown and
 * buttons that work without opening the app (✓ Klaar, ▶ Bezig) or open it (✗ Nog niet).
 *
 * The app hands the native side a short queue of today's planned tasks; which one is shown,
 * and moving on to the next after ✓, happens natively (packages/mobile/native/widget/
 * CheckinLive.swift), so it also works while the app sleeps. What was pressed there comes
 * back through liveTake() and is applied to this copy of the data when the app runs again.
 */

import type { Backend } from '@backend/create.js'
import { isImportant } from '@core/services/reminders.js'
import { fromIsoDate, toIsoDate } from '@core/util/time.js'

export interface LiveBlock {
  taskId: string
  title: string
  /** Epoch ms. */
  start: number
  end: number
  important: boolean
  project: string | null
  /** The timer runs on it. */
  busy: boolean
}

const MIN = 60_000

/** What runs on the timer right now, if anything. */
export interface Running {
  taskId: string
  startedAt: number
}

/**
 * Today's and tomorrow's planned tasks that are not done and not long over, in order, plus
 * the task the timer runs on even when no block holds it (reopened after a Klaar, or started
 * without a plan): that one is what he is doing, so it is what the lock screen shows.
 */
export function liveQueue(backend: Backend, running: Running | null, now = Date.now()): LiveBlock[] {
  const runningTaskId = running?.taskId ?? null
  const out: LiveBlock[] = []
  for (const day of [toIsoDate(now), toIsoDate(now + 86_400_000)]) {
    const plan = backend.store.plans.accepted('day', day)
    if (!plan) continue
    for (const block of backend.store.plans.blocks(plan.id)) {
      if (block.kind !== 'task' || !block.taskId) continue
      const task = backend.store.tasks.get(block.taskId)
      if (!task || task.status === 'done') continue
      const start = fromIsoDate(block.date).getTime() + block.startMin * MIN
      const end = fromIsoDate(block.date).getTime() + block.endMin * MIN
      if (end < now - 60 * MIN) continue
      out.push({
        taskId: block.taskId,
        title: block.taskTitle ?? block.title ?? task.title,
        start,
        end,
        important: isImportant(task, block.date),
        project: block.projectName ?? null,
        busy: block.taskId === runningTaskId
      })
    }
  }
  if (running && !out.some((block) => block.taskId === running.taskId && block.start <= now && block.end > now)) {
    const task = backend.store.tasks.get(running.taskId)
    if (task) {
      const planned = Math.max(15, task.estimateMin ?? 60)
      out.push({
        taskId: task.id,
        title: task.title,
        start: running.startedAt,
        // Its estimate from when the timer started; never already over while it still runs.
        end: Math.max(running.startedAt + planned * MIN, now + 15 * MIN),
        important: isImportant(task, toIsoDate(now)),
        project: null,
        busy: true
      })
    }
  }
  return out.sort((a, b) => a.start - b.start).slice(0, 12)
}
