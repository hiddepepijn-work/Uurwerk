import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { TOOLS } from '@core/services/jarvis-tools.js'

import { writeFileSync } from 'node:fs'

import { addTextUsage, addUsage, dateTable, readSpend, toSchema, usageUsd } from './live.js'

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jarvis-live-'))
  path = join(dir, 'jarvis-live.json')
  delete process.env.JARVIS_LIVE_CAP_USD
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('live spend', () => {
  it('starts the month at zero with the default cap', () => {
    const spend = readSpend(path)
    expect(spend.usd).toBe(0)
    expect(spend.capUsd).toBe(10)
  })

  it('prices text and audio apart, thinking as text output', () => {
    addUsage(path, { textIn: 1_000_000, audioIn: 1_000_000, textOut: 0, audioOut: 0, thoughts: 0 })
    const spend = addUsage(path, { textIn: 0, audioIn: 0, textOut: 1_000_000, audioOut: 1_000_000, thoughts: 1_000_000 })
    expect(spend.usd).toBeCloseTo(0.75 + 3 + 4.5 + 12 + 4.5)
    expect(readSpend(path).usd).toBeCloseTo(24.75)
  })

  it('prices OpenAI at its own rates, cached input at the cached rate', () => {
    const spend = addUsage(path, {
      provider: 'openai',
      textIn: 1_000_000,
      textInCached: 500_000,
      audioIn: 1_000_000,
      audioInCached: 1_000_000,
      textOut: 1_000_000,
      audioOut: 1_000_000,
      thoughts: 0
    })
    expect(spend.usd).toBeCloseTo(0.3 + 0.03 + 0.3 + 2.4 + 20)
  })

  it('prices the full realtime model at its own, higher rates', () => {
    const usd = usageUsd({ provider: 'openai', textIn: 1_000_000, audioIn: 0, textOut: 1_000_000, audioOut: 1_000_000, thoughts: 0 }, 'gpt-realtime-2.1')
    expect(usd).toBeCloseTo(4 + 24 + 64)
  })

  it('ignores nonsense counts', () => {
    const spend = addUsage(path, { textIn: -5, audioIn: Number.NaN, textOut: 0, audioOut: 0, thoughts: 0 })
    expect(spend.usd).toBe(0)
  })

  it('counts typed Jarvis too, cached input at a tenth, and keeps the two apart', () => {
    addUsage(path, { textIn: 1_000_000, audioIn: 0, textOut: 0, audioOut: 0, thoughts: 0 })
    const spend = addTextUsage(path, { prompt: 2_000_000, cached: 1_000_000, output: 100_000, thoughts: 100_000 })
    expect(spend.live).toBeCloseTo(0.75)
    expect(spend.text).toBeCloseTo(0.75 + 0.075 + 0.75)
    expect(spend.usd).toBeCloseTo(spend.live + spend.text)
  })

  it('reads a file from before the split as Live spending', () => {
    const month = new Date().toISOString().slice(0, 7)
    writeFileSync(path, JSON.stringify({ month, usd: 1.5 }))
    expect(readSpend(path)).toMatchObject({ usd: 1.5, live: 1.5, text: 0 })
  })

  it('takes the cap from the environment', () => {
    process.env.JARVIS_LIVE_CAP_USD = '4'
    expect(readSpend(path).capUsd).toBe(4)
  })
})

describe('toSchema', () => {
  it('turns every tool into Gemini schema: upper-case types, no additionalProperties', () => {
    for (const tool of TOOLS) {
      const schema = JSON.stringify(toSchema(tool.parameters))
      expect(schema).not.toContain('additionalProperties')
      expect(schema).not.toMatch(/"type":"[a-z]/)
    }
  })
})

describe('dateTable', () => {
  it('names this week and next, so "volgende week donderdag" is read off, not worked out', () => {
    // Monday 28 September 2026.
    const table = dateTable(new Date(2026, 8, 28, 12, 0))
    expect(table).toContain('ma 2026-09-28 (vandaag)')
    expect(table).toContain('di 2026-09-29 (morgen)')
    expect(table).toContain('do 2026-10-01')
    expect(table).toContain('volgende week: ma 2026-10-05')
    expect(table).toContain('do 2026-10-08')
    expect(table).not.toContain('2026-10-12')
  })

  it('still reaches the end of next week on a Sunday', () => {
    const table = dateTable(new Date(2026, 9, 4, 12, 0))
    expect(table).toContain('zo 2026-10-04 (vandaag)')
    expect(table).toContain('volgende week: ma 2026-10-05')
    expect(table).toContain('zo 2026-10-11')
  })
})
