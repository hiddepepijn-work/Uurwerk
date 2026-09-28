import type { IsoDate } from '@core/contract/types.js'

import { api } from '../../api/client.js'

/**
 * What you can do to the agenda by hand. Everything placed or moved here counts as set by
 * hand: the planner plans around it and a replan leaves it where you put it.
 */

/** A task as a block at a time: into the day's plan in force, or a new one accepted at once. */
export async function placeTask(taskId: string, date: IsoDate, startMin: number, endMin: number): Promise<void> {
  const day = await api.plans.day(date)
  const task = await api.tasks.get(taskId)
  let planId = day.plan?.status === 'accepted' ? day.plan.id : null
  const needsAccept = planId === null
  if (!planId) {
    const draft = await api.plans.draft(date)
    if (!draft.plan) throw new Error('Kon voor die dag geen planning openen.')
    planId = draft.plan.id
  }
  await api.plans.addBlock(planId, {
    taskId,
    areaId: task?.areaId ?? null,
    date,
    startMin,
    endMin,
    kind: 'task',
    source: 'manual',
    locked: true
  })
  if (needsAccept) await api.plans.accept(planId)
}

/** A block dragged to another time on the same day, its length kept. */
export async function moveBlock(blockId: string, startMin: number, endMin: number): Promise<void> {
  await api.plans.updateBlock(blockId, { startMin, endMin, source: 'manual', locked: true })
}
