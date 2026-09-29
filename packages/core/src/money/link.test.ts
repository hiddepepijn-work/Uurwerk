import { describe, expect, it } from 'vitest'

import { openStore } from '../db/index.js'
import { atMinuteOfDay } from '../util/time.js'
import { FEDEX_ORGANIZATION, MoneyLink } from './link.js'

const TODAY = '2026-11-17'

function setup() {
  const store = openStore(':memory:')
  store.money.loadStarter()
  return { store, link: new MoneyLink(store) }
}

const appointments = (store: ReturnType<typeof openStore>) =>
  store.db.all<{ id: string; title: string; starts_at: number; event_kind: string; description: string | null; deleted_at: number | null }>(
    'SELECT id, title, starts_at, event_kind, description, deleted_at FROM calendar_events ORDER BY starts_at'
  )

describe('Geld and the agenda', () => {
  it('puts a planned shift in the agenda with the drive, and moves it along', () => {
    const { store, link } = setup()
    const shift = store.money.saveShift({ date: '2026-11-18', template: 'nacht', status: 'planned' })
    link.pushShift(shift)
    const live = appointments(store).filter((event) => event.deleted_at === null)
    expect(live.map((event) => event.event_kind)).toEqual(['travel', 'appointment', 'travel'])
    const main = live.find((event) => event.event_kind === 'appointment')!
    expect(main.title).toBe('FedEx · Nacht')
    expect(main.starts_at).toBe(atMinuteOfDay('2026-11-18', 23 * 60))
    expect(main.description).toBe(`geld:shift:${shift.id}`)
    // No amounts in the agenda.
    expect(JSON.stringify(live)).not.toMatch(/€|\d+,\d{2}/)

    link.pushShift(store.money.saveShift({ ...shift, date: '2026-11-19' }))
    const moved = appointments(store).filter((event) => event.deleted_at === null)
    expect(moved.find((event) => event.event_kind === 'appointment')!.starts_at).toBe(atMinuteOfDay('2026-11-19', 23 * 60))
    expect(moved).toHaveLength(3)
  })

  it('takes a FedEx appointment made in the agenda into Geld, and drops it when deleted there', () => {
    const { store, link } = setup()
    link.reconcile(TODAY)
    const event = store.calendar.createEvent({
      title: 'Werken',
      startsAt: atMinuteOfDay('2026-11-20', 17 * 60 + 30),
      endsAt: atMinuteOfDay('2026-11-21', 60),
      organizationId: FEDEX_ORGANIZATION,
      areaId: 'work'
    })
    const changes = link.reconcile(TODAY)
    expect(changes.money).toBe(true)
    expect(store.money.state().shifts).toMatchObject([{ id: `agenda-${event.id}`, date: '2026-11-20', template: 'laat', status: 'planned' }])
    // A second pass changes nothing.
    expect(link.reconcile(TODAY)).toEqual({ tasks: false, planning: false, money: false })

    store.calendar.softDelete(event.id)
    link.reconcile(TODAY)
    expect(store.money.state().shifts).toEqual([])
  })

  it('removes the appointment when the shift is removed in Geld, and cleans up doubles', () => {
    const { store, link } = setup()
    const shift = store.money.saveShift({ date: '2026-11-25', template: 'avond', status: 'planned' })
    link.pushShift(shift)
    // A second device made one too before the sync caught up.
    store.calendar.createEvent({ title: 'FedEx · Avond', description: `geld:shift:${shift.id}`, startsAt: atMinuteOfDay('2026-11-25', 870), endsAt: atMinuteOfDay('2026-11-25', 1380) })
    link.reconcile(TODAY)
    expect(appointments(store).filter((event) => event.event_kind === 'appointment' && event.deleted_at === null)).toHaveLength(1)

    link.dropShift(shift.id)
    store.money.removeShift(shift.id)
    expect(appointments(store).filter((event) => event.deleted_at === null)).toEqual([])
  })

  it('warns for a night shift before a stage morning', () => {
    const { store, link } = setup()
    // Default availability: stage Monday to Friday from 09:00.
    expect(link.nightBeforeStage(store.money.saveShift({ date: '2026-11-17', template: 'nacht', status: 'planned' }))).toBe(true)
    expect(link.nightBeforeStage(store.money.saveShift({ date: '2026-11-20', template: 'nacht', status: 'planned' }))).toBe(false)
    expect(link.nightBeforeStage(store.money.saveShift({ date: '2026-11-17', template: 'avond', status: 'planned' }))).toBe(false)
  })
})

describe('Geld and the task list', () => {
  it('makes a task per milestone without amounts, and ticks it off once paid', () => {
    const { store, link } = setup()
    link.reconcile(TODAY)
    const tasks = () => store.db.all<{ title: string; status: string; due_date: string }>("SELECT title, status, due_date FROM tasks WHERE notes LIKE 'geld:%' ORDER BY due_date")
    expect(tasks().map((task) => task.title)).toEqual([
      'Geld: oktober afsluiten',
      'Lange vlucht (reis)',
      'Vluchten Azië (reis)',
      'Vaccinaties (reis)',
      'Verzekering + e-visa (reis)'
    ])
    expect(tasks()[1]).toMatchObject({ due_date: '2026-12-15', status: 'open' })

    const flight = store.money.state().milestones[0]!
    store.money.saveMilestone({ ...flight, paid: true })
    link.reconcile(TODAY)
    expect(tasks()[1]!.status).toBe('done')

    store.money.close('2026-10', TODAY)
    link.reconcile(TODAY)
    expect(tasks()[0]!.status).toBe('done')

    // Twice changes nothing more.
    expect(link.reconcile(TODAY).tasks).toBe(false)
  })

  it('asks for the hours on the Monday after a week with shifts', () => {
    const { store, link } = setup()
    store.money.saveShift({ date: '2026-11-18', template: 'nacht', status: 'worked' })
    link.reconcile('2026-11-19')
    const hours = store.db.get<{ title: string; due_date: string }>("SELECT title, due_date FROM tasks WHERE notes LIKE 'geld:hours:%'")
    expect(hours).toEqual({ title: 'Uren indienen Adecco (vóór 12:00)', due_date: '2026-11-23' })
  })
})
