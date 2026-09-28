import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { briefForModel } from './brief.js'

const brief = readFileSync('docs/jarvis.md', 'utf8')

describe('briefForModel', () => {
  const model = briefForModel(brief)

  it('keeps everything that shapes how he behaves', () => {
    for (const kept of [
      'Zevenaar',
      'Nieuwendijk',
      'woensdag en vrijdag',
      'FedEx in Duiven',
      'Tessie',
      '08:30',
      'opruimen achter jezelf aan',
      'Afsprakenvragen',
      'Takenvragen',
      '14, 7, 3 en 1 dag',
      'Streng.',
      'Maasarend'
    ]) {
      expect(model).toContain(kept)
    }
  })

  it('leaves out what is for Hidde, not for him', () => {
    for (const gone of ['Werkdocument', '## Techniek', '## Privacy', 'JARVIS_MODEL', 'In de app nu al', '**Al in de app**', '❓']) {
      expect(model).not.toContain(gone)
    }
  })

  it('keeps a fact that has an open question after it', () => {
    expect(model).toContain('donderdag thuis (geen reis).')
  })

  it('is much shorter', () => {
    expect(model.length).toBeLessThan(brief.length * 0.75)
  })
})
