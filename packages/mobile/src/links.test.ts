import { describe, expect, it } from 'vitest'

import { parseLink } from './links.js'

describe('parseLink', () => {
  it('reads the widget buttons', () => {
    expect(parseLink('uurwerk://timer')).toEqual({ action: 'timer', moment: null })
    expect(parseLink('uurwerk://jarvis')).toEqual({ action: 'jarvis', moment: null })
    expect(parseLink('uurwerk://agenda/')).toEqual({ action: 'agenda', moment: null })
  })

  it('reads the moment the Shortcuts automations pass', () => {
    expect(parseLink('uurwerk://jarvis?moment=morning')).toEqual({ action: 'jarvis', moment: 'morning' })
    expect(parseLink('uurwerk://jarvis?moment=Evening')).toEqual({ action: 'jarvis', moment: 'evening' })
    expect(parseLink('uurwerk://jarvis/?moment=evening#x')).toEqual({ action: 'jarvis', moment: 'evening' })
  })

  it('ignores what it does not know', () => {
    expect(parseLink('uurwerk://jarvis?moment=noon')).toEqual({ action: 'jarvis', moment: null })
    expect(parseLink('uurwerk://nothing')).toEqual({ action: null, moment: null })
  })
})

describe('the Live Activity link', () => {
  it('carries the task and the answer', () => {
    expect(parseLink('uurwerk://checkin?task=t1&stage=end&important=1&title=BO%20afmaken').checkin).toEqual({
      taskId: 't1',
      answer: 'notdone',
      stage: 'end',
      important: true,
      task: 'BO afmaken'
    })
    expect(parseLink('uurwerk://checkin?task=t1&stage=midway').checkin?.answer).toBe('notyet')
  })

  it('is nothing without a task', () => {
    expect(parseLink('uurwerk://checkin?stage=end').action).toBeNull()
  })
})
