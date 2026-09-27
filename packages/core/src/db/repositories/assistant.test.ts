import { describe, expect, it } from 'vitest'

import { openStore } from '../index.js'
import { syncedTables } from '../../sync/schema.js'

describe('Jarvis in the database', () => {
  it('keeps rules: hard and soft, with their own config', () => {
    const store = openStore(':memory:')
    const hard = store.rules.add({
      kind: 'hard',
      type: 'availability',
      config: { context: 'stage', days: ['ma', 'di', 'wo', 'do'], from: '09:00', to: '17:00' },
      description: 'Stage alleen ma t/m do, 9 tot 5'
    })
    store.rules.add({ kind: 'soft', type: 'note', description: 'Liever geen zwaar denkwerk na 20:00' })

    expect(store.rules.list().map((rule) => rule.kind)).toEqual(['hard', 'soft'])
    expect(store.rules.get(hard.id)?.config).toMatchObject({ context: 'stage', from: '09:00' })

    store.rules.update(hard.id, { active: false })
    expect(store.rules.list()).toHaveLength(1)
    expect(store.rules.list(true)).toHaveLength(2)
  })

  it('logs the day: opening once, closing, and the summary to start from', () => {
    const store = openStore(':memory:')
    expect(store.dayLog.get('2026-09-28').openingDoneAt).toBeNull()

    const opened = store.dayLog.mark('2026-09-28', { opening: true })
    expect(opened.openingDoneAt).not.toBeNull()
    // A second opening keeps the first time.
    expect(store.dayLog.mark('2026-09-28', { opening: true }).openingDoneAt).toBe(opened.openingDoneAt)

    store.dayLog.mark('2026-09-28', { closing: true, summary: 'BO af, Wie betaalt wat niet.' })
    expect(store.dayLog.get('2026-09-28')).toMatchObject({ summary: 'BO af, Wie betaalt wat niet.' })
    expect(store.dayLog.lastSummaryBefore('2026-09-29')?.date).toBe('2026-09-28')
    expect(store.dayLog.lastSummaryBefore('2026-09-28')).toBeNull()
  })

  it('keeps proposals and what came of them', () => {
    const store = openStore(':memory:')
    const proposal = store.proposals.create({
      tool: 'schedule_task',
      payload: { taskId: 't1', date: '2026-09-28', start: '20:00', end: '21:00' },
      summary: 'Taak inplannen',
      expiresAt: Date.now() + 60_000
    })
    expect(store.proposals.pending().map((entry) => entry.id)).toEqual([proposal.id])

    store.proposals.settle(proposal.id, { status: 'executed', result: { placed: '2026-09-28 20:00–21:00' } })
    expect(store.proposals.pending()).toEqual([])
    expect(store.proposals.get(proposal.id)).toMatchObject({ status: 'executed', result: { placed: '2026-09-28 20:00–21:00' } })
  })

  it('syncs the rules and the day log, but never the proposals', () => {
    const store = openStore(':memory:')
    const names = syncedTables(store.db).map((table) => table.name)
    expect(names).toContain('rules')
    expect(names).toContain('jarvis_day_log')
    expect(names).not.toContain('_jarvis_proposals')
  })
})
