import { describe, expect, it } from 'vitest'

import type { PlanBlock } from '@core/contract/types.js'

import { agendaFor } from './agenda-model.js'

const block = (id: string, startMin: number, endMin: number, title = id): PlanBlock => ({
  id,
  planId: 'p',
  taskId: `task-${id}`,
  taskTitle: title,
  areaId: 'stage',
  projectName: null,
  projectColor: null,
  date: '2026-09-28',
  startMin,
  endMin,
  kind: 'task',
  title: null,
  fixed: false,
  locked: false,
  source: 'planner',
  originalBlockId: null,
  explanation: null,
  score: null,
  createdBy: null
})

describe('agendaFor', () => {
  it('only narrows an item where something overlaps it', () => {
    // A long block, a crowded quarter hour at its start, and a late block beside it.
    const { items } = agendaFor(
      '2026-09-28',
      [block('a', 540, 720), block('b', 540, 570), block('c', 555, 585), block('d', 660, 720)],
      []
    )
    const byId = Object.fromEntries(items.map((item) => [item.title, item]))
    expect(byId.a).toMatchObject({ lane: 0, lanes: 3, span: 1 })
    expect(byId.b).toMatchObject({ lane: 1, span: 1 })
    expect(byId.c).toMatchObject({ lane: 2, span: 1 })
    // D only meets A: it takes the two lanes the crowd left, not a third of the width.
    expect(byId.d).toMatchObject({ lane: 1, span: 2 })
  })

  it('knows what each item is in the database', () => {
    const { items } = agendaFor('2026-09-28', [block('a', 540, 600)], [])
    expect(items[0]!.source).toEqual({ type: 'block', blockId: 'a', taskId: 'task-a' })
  })
})
