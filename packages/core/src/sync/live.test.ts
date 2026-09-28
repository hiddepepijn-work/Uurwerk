import { describe, expect, it } from 'vitest'

import { readEvents } from './live.js'

describe('reading the live channel', () => {
  it('finds the event names in complete blocks and keeps the unfinished one', () => {
    const { events, rest } = readEvents(': verbonden\n\nevent: data:invalidated\ndata: {"domain":"tasks"}\n\nevent: tracking:segm')
    expect(events).toEqual(['data:invalidated'])
    expect(rest).toBe('event: tracking:segm')
  })

  it('ignores keep-alives and copes with CRLF line ends', () => {
    const { events } = readEvents(': \r\n\r\nevent: tracking:segmentChanged\r\ndata: {}\r\n\r\n')
    expect(events).toEqual(['tracking:segmentChanged'])
  })
})
