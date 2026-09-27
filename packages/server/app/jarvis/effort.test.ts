import { describe, expect, it } from 'vitest'

import { effortFor } from './effort.js'

describe('effortFor', () => {
  it('thinks low for everyday questions', () => {
    for (const text of ['Wat staat er morgen op de planning?', 'Hoe laat moet ik weg?', 'Zet een afspraak met Juul om vijf uur', 'ja']) {
      expect(effortFor(text, 'low', 'medium')).toBe('low')
    }
  })

  it('thinks harder when the agenda is rearranged', () => {
    for (const text of [
      'Haal alle planning behalve de twee privé-afspraken weg en plan opnieuw tot 6 oktober',
      'Plan de week opnieuw',
      'Kun je BO afmaken inplannen na mijn afspraken?',
      'Verzet alles van woensdag naar donderdag'
    ]) {
      expect(effortFor(text, 'low', 'medium')).toBe('medium')
    }
  })
})
