import { describe, expect, it } from 'vitest'

import { isSprintCommand, sprintAt, sprintFrom } from './sprint.js'

describe('the five-second command', () => {
  it('hears it however it is said', () => {
    for (const text of ['5 sec', '5 sec.', 'Vijf seconden', '5 seconden modus', 'Hey Jarvis, 5 sec!', 'five seconds', '5s', 'de vijf seconden regel', '5 sec graag']) {
      expect(isSprintCommand(text), text).toBe(true)
    }
  })

  it('leaves real sentences to Jarvis', () => {
    for (const text of ['Ik ben over 5 seconden klaar met eten', 'zet een timer van 5 minuten', '5 taken voor vandaag', 'hoe laat is het', '']) {
      expect(isSprintCommand(text), text).toBe(false)
    }
  })

  it('counts down five seconds, then ten minutes of focus, then nothing', () => {
    const sprint = sprintFrom(1_000_000)
    expect(sprintAt(sprint, 1_002_000).phase).toBe('countdown')
    expect(sprintAt(sprint, 1_005_000).phase).toBe('focus')
    expect(sprintAt(sprint, 1_005_000 + 599_000).phase).toBe('focus')
    expect(sprintAt(sprint, 1_005_000 + 600_000).phase).toBe('idle')
  })
})
