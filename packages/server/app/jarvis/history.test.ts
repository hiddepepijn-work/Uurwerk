import { describe, expect, it } from 'vitest'

import { condense, WINDOW, windowStart, withoutState, withState } from './providers.js'

describe('what stays in the history', () => {
  it('keeps the state of the day only on the newest message', () => {
    const message = withState('Nu: zondag\nza 27/9\n  (niets)', 'Wat heb ik morgen?')
    expect(message.startsWith('[stand]')).toBe(true)
    expect(withoutState(message)).toBe('Wat heb ik morgen?')
    expect(withoutState('Gewoon een vraag')).toBe('Gewoon een vraag')
  })

  it('cuts a used tool result to a line, and keeps what a confirm did', () => {
    expect(condense('{"saved":true}')).toBe('{"saved":true}')
    const long = JSON.stringify({ days: Array.from({ length: 40 }, (_, index) => ({ block: index, title: 'Architectuur onderzoek' })) })
    expect(condense(long).length).toBeLessThan(220)
    const confirm = JSON.stringify({
      executed: [{ summary: 'Planning opnieuw', result: { plannedBlocks: 12, notPlaced: Array(30).fill('x'.repeat(20)) } }],
      failed: [{ summary: 'Afspraak verwijderen', error: 'bestaat niet' }],
      alreadyDone: [],
      say: 'Vertel Hidde precies dit'
    })
    expect(JSON.parse(condense(confirm))).toEqual({ uitgevoerd: ['Planning opnieuw'], mislukt: ['Afspraak verwijderen: bestaat niet'] })
  })

  it('sends only the last window, starting at a question, never inside a tool exchange', () => {
    type M = { role: 'system' | 'user' | 'assistant' | 'tool' }
    const messages: M[] = [{ role: 'system' }]
    for (let turn = 0; turn < 8; turn++) messages.push({ role: 'user' }, { role: 'assistant' }, { role: 'tool' }, { role: 'assistant' })
    const start = windowStart(messages, 1, (message) => message.role === 'user')
    expect(messages[start]!.role).toBe('user')
    expect(messages.length - start).toBeLessThanOrEqual(WINDOW)
    // A single long exchange still keeps its own question.
    const one: M[] = [{ role: 'system' }, { role: 'user' }, ...Array.from({ length: 20 }, () => ({ role: 'tool' as const }))]
    expect(windowStart(one, 1, (message) => message.role === 'user')).toBe(1)
  })
})
