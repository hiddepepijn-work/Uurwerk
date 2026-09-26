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

  it('adds input at $3 and output plus thinking at $12 per million tokens', () => {
    addUsage(path, { promptTokens: 1_000_000, responseTokens: 0, thoughtsTokens: 0 })
    const spend = addUsage(path, { promptTokens: 0, responseTokens: 500_000, thoughtsTokens: 500_000 })
    expect(spend.usd).toBeCloseTo(15)
    expect(readSpend(path).usd).toBeCloseTo(15)
  })

  it('ignores nonsense counts', () => {
    const spend = addUsage(path, { promptTokens: -5, responseTokens: Number.NaN, thoughtsTokens: 0 })
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
