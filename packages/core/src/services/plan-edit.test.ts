import { beforeEach, describe, expect, it } from 'vitest'
import { openStore, type Store } from '../db/index.js'
import { SYSTEM_AREAS } from '../contract/types.js'
import { PlanEditService } from './plan-edit.js'

let store: Store
let planEdit: PlanEditService

beforeEach(() => {
  store = openStore(':memory:')
  planEdit = new PlanEditService(store)
})

const task = (title: string): string =>
  store.tasks.create({ title, areaId: SYSTEM_AREAS.stage }).id

function block(taskId: string, date: string, startMin = 9 * 60, endMin = 10 * 60): string {
  const draft = store.plans.createDraft({ scope: 'day', periodKey: date })
  return store.plans.addBlock(draft.id, { taskId, date, startMin, endMin }).id
}

describe('postponing', () => {
  it('counts a move to a later day', () => {
    const id = task('Keeps sliding')
    const blockId = block(id, '2026-08-03')

    planEdit.updateBlock(blockId, { date: '2026-08-04' })

    expect(store.tasks.get(id)!.postponedCount).toBe(1)
  })

  it('counts each move, so repeated drift is visible', () => {
    const id = task('Keeps sliding')
    const blockId = block(id, '2026-08-03')

    planEdit.updateBlock(blockId, { date: '2026-08-04' })
    planEdit.updateBlock(blockId, { date: '2026-08-05' })

    expect(store.tasks.get(id)!.postponedCount).toBe(2)
  })

  it('does not count moving a block earlier', () => {
    const id = task('Pulled forward')
    const blockId = block(id, '2026-08-05')

    planEdit.updateBlock(blockId, { date: '2026-08-04' })

    expect(store.tasks.get(id)!.postponedCount).toBe(0)
  })

  it('does not count dragging a block within the same day', () => {
    const id = task('Moved after lunch')
    const blockId = block(id, '2026-08-03')

    planEdit.updateBlock(blockId, { startMin: 14 * 60, endMin: 15 * 60 })

    expect(store.tasks.get(id)!.postponedCount).toBe(0)
    expect(store.plans.getBlock(blockId)!.startMin).toBe(14 * 60)
  })

  it('leaves a break or a meeting alone — there is no task to postpone', () => {
    const draft = store.plans.createDraft({ scope: 'day', periodKey: '2026-08-03' })
    const lunch = store.plans.addBlock(draft.id, {
      date: '2026-08-03',
      startMin: 12 * 60,
      endMin: 13 * 60,
      kind: 'break',
      title: 'Lunch'
    })

    expect(() => planEdit.updateBlock(lunch.id, { date: '2026-08-04' })).not.toThrow()
  })
})
