import { describe, expect, it } from 'vitest'
import { openStore } from '../index.js'

describe('what waits to be classified', () => {
  it('never an all-day item: a birthday or someone else’s workday holds no hours', () => {
    const store = openStore(':memory:')
    const day = new Date('2026-10-01T00:00:00').getTime()
    store.calendar.createEvent({ title: 'Tessie werkdag', startsAt: day, endsAt: day + 86_400_000, allDay: true, origin: 'icloud', classificationStatus: 'suggested' })
    store.calendar.createEvent({ title: 'Tandarts', startsAt: day + 10 * 3_600_000, endsAt: day + 11 * 3_600_000, origin: 'icloud', classificationStatus: 'suggested' })
    expect(store.calendar.unclassified().map((event) => event.title)).toEqual(['Tandarts'])
  })
})
