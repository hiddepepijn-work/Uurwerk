import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { TOOLS } from '@core/services/jarvis-tools.js'

import { addUsage, readSpend, toSchema } from './live.js'

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

  it('ignores nonsense counts', () => {
    const spend = addUsage(path, { textIn: -5, audioIn: Number.NaN, textOut: 0, audioOut: 0, thoughts: 0 })
    expect(spend.usd).toBe(0)
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
