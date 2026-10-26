import { beforeEach, describe, expect, it } from 'vitest'
import { openStore, type Store } from '../db/index.js'
import { SYSTEM_AREAS } from '../contract/types.js'
import { fromIsoDate } from '../util/time.js'
import { extraNudgeInput, prepOpen, prepSweep, prepTaskId, prepTemplate } from './prep.js'
import { extraNudges } from './reminders.js'

let store: Store
/** Monday 2 November 2026, nine in the morning. */
const NOW = fromIsoDate('2026-11-02').getTime() + 9 * 3_600_000
const at = (day: string, hour: number): number => fromIsoDate(day).getTime() + hour * 3_600_000

beforeEach(() => {
  store = openStore(':memory:')
})

describe('which preparation a title asks for', () => {
  it('knows a resit and a trip, and leaves the rest alone', () => {
    expect(prepTemplate('Python herkansing met Loes')).toBe('exam')
    expect(prepTemplate('Vlucht naar Bangkok')).toBe('trip')
    expect(prepTemplate('Vakantie Texel')).toBe('trip')
    expect(prepTemplate('Tandarts')).toBeNull()
    expect(prepTemplate('Herinnering: morgen assessment Python')).toBeNull()
  })
})

describe('the preparation sweep', () => {
  it('adds "check what to hand in" a week before a resit, once', () => {
    const event = store.calendar.createEvent({
      title: 'Python herkansing',
      startsAt: at('2026-11-20', 10),
      endsAt: at('2026-11-20', 14),
      origin: 'uurwerk',
      classificationStatus: 'confirmed'
    })

    const first = prepSweep(store, NOW)
    const again = prepSweep(store, NOW)

    expect(first.created).toEqual([prepTaskId(`a:${event.id}`)])
    expect(again.created).toEqual([])
    const task = store.tasks.get(prepTaskId(`a:${event.id}`))!
    expect(task.title).toContain('inleveren')
    expect(task.dueDate).toBe('2026-11-13')
    expect(task.remindAt).toEqual(['2026-11-13T09:00'])
    expect(task.prepFor).toBe(`a:${event.id}`)
    expect(store.prep.get(`a:${event.id}`)?.status).toBe('planned')
  })

  it('packs the bag the evening before a trip, with a checklist', () => {
    const id = store.tasks.create({ title: 'Reis naar Thailand', areaId: SYSTEM_AREAS.personal, dueDate: '2026-11-10' }).id

    prepSweep(store, NOW)

    const bag = store.tasks.get(prepTaskId(`t:${id}`))!
    expect(bag.title).toBe('Tas pakken: Reis naar Thailand')
    expect(bag.dueDate).toBe('2026-11-09')
    expect(bag.checklist.length).toBeGreaterThan(3)
    expect(bag.remindAt).toEqual(['2026-11-09T19:30'])
  })

  it('does not bring back a prep task that was deleted', () => {
    const id = store.tasks.create({ title: 'Tentamen GIS', areaId: SYSTEM_AREAS.stage, dueDate: '2026-11-20' }).id
    prepSweep(store, NOW)
    store.tasks.remove(prepTaskId(`t:${id}`))

    expect(prepSweep(store, NOW).created).toEqual([])
  })

  it('asks about something important without a template, and leaves the rest for Jarvis', () => {
    const important = store.tasks.create({ title: 'Gesprek met Jeroen', areaId: SYSTEM_AREAS.stage, priority: 'high', dueDate: '2026-11-05' }).id
    const plain = store.tasks.create({ title: 'Mail sturen', areaId: SYSTEM_AREAS.stage, dueDate: '2026-11-05' }).id

    expect(prepSweep(store, NOW).asked).toEqual([`t:${important}`])
    const open = prepOpen(store, NOW)
    expect(open.asked.map((item) => item.ref)).toEqual([`t:${important}`])
    expect(open.unchecked.map((item) => item.ref)).toEqual([`t:${plain}`])
  })
})

describe('the rest of the nagging', () => {
  it('says every day that tasks have been sitting without a date', () => {
    store.tasks.create({ title: 'Opruimen', areaId: SYSTEM_AREAS.personal })
    // Made a week ago.
    store.db.run('UPDATE tasks SET created_at = ?', [NOW - 7 * 86_400_000])

    const nudges = extraNudges(extraNudgeInput(store, NOW), NOW, NOW + 2 * 86_400_000)
    const undated = nudges.filter((nudge) => nudge.key.startsWith('nudge:undated:'))

    expect(undated).toHaveLength(2)
    expect(undated[0]!.title).toContain('Opruimen')
  })

  it('warns at nine in the evening when tomorrow has nothing planned', () => {
    const nudges = extraNudges(extraNudgeInput(store, NOW), NOW, NOW + 86_400_000)
    const evening = nudges.find((nudge) => nudge.key === 'nudge:tomorrow:2026-11-02')

    expect(evening?.at).toBe(at('2026-11-02', 21))
  })

  it('pushes a task at its own moment, with the steps still open', () => {
    store.tasks.create({
      title: 'Tas pakken',
      areaId: SYSTEM_AREAS.personal,
      checklist: [
        { text: 'Paspoort', done: true },
        { text: 'Oplader', done: false }
      ],
      remindAt: ['2026-11-02T19:30']
    })

    const own = extraNudges(extraNudgeInput(store, NOW), NOW, NOW + 86_400_000).find((nudge) => nudge.key.startsWith('nudge:own:'))

    expect(own?.at).toBe(at('2026-11-02', 19) + 30 * 60_000)
    expect(own?.body).toBe('Nog: Oplader')
  })
})
