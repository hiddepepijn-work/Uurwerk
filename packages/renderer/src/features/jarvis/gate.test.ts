import { describe, expect, it } from 'vitest'

import { HANGOVER_MS, SpeechGate } from './gate.js'

/** Feeds 40 ms chunks at a level, from a start time; returns what the gate did. */
function feed(gate: SpeechGate, from: number, ms: number, rms: number, speaking = false) {
  const decisions = []
  for (let at = from; at < from + ms; at += 40) decisions.push(gate.hear(rms, at, speaking))
  return decisions
}

describe('SpeechGate', () => {
  it('does not take room noise or breathing for talking', () => {
    const gate = new SpeechGate()
    expect(feed(gate, 0, 3000, 0.005).some((decision) => decision.send)).toBe(false)
    expect(feed(gate, 3000, 2000, 0.009).some((decision) => decision.send)).toBe(false)
  })

  it('opens on speech', () => {
    const gate = new SpeechGate()
    feed(gate, 0, 1000, 0.003)
    expect(feed(gate, 1000, 200, 0.05).some((decision) => decision.opened)).toBe(true)
  })

  it('does not let Jarvis interrupt himself: his echo does not open the gate while he talks', () => {
    const gate = new SpeechGate()
    feed(gate, 0, 1000, 0.003)
    // His voice through the speaker, picked up at 0.02–0.04.
    const echo = [...feed(gate, 1000, 2000, 0.03, true), ...feed(gate, 3000, 2000, 0.04, true)]
    expect(echo.some((decision) => decision.opened)).toBe(false)
    // Hidde talking over him, clearly louder, does.
    expect(feed(gate, 5000, 200, 0.15, true).some((decision) => decision.opened)).toBe(true)
  })

  it('keeps one sentence with a pause in it as one turn', () => {
    const gate = new SpeechGate()
    feed(gate, 0, 1000, 0.003)
    const first = feed(gate, 1000, 1500, 0.05)
    const breath = feed(gate, 2500, 1200, 0.003)
    const rest = feed(gate, 3700, 1500, 0.05)
    expect(first.filter((decision) => decision.opened)).toHaveLength(1)
    expect([...breath, ...rest].some((decision) => decision.closed || decision.opened)).toBe(false)
    // And after it, the turn does end.
    const after = feed(gate, 5200, HANGOVER_MS + 400, 0.003)
    expect(after.filter((decision) => decision.closed)).toHaveLength(1)
  })
})
