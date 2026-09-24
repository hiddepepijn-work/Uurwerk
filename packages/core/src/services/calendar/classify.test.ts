import { beforeEach, describe, expect, it } from 'vitest'
import { openStore, type Store } from '../../db/index.js'
import { SYSTEM_AREAS, SYSTEM_ORGANIZATIONS, type CalendarSource } from '../../contract/types.js'
import {
  HIGH_CONFIDENCE,
  LOW_CONFIDENCE,
  classify,
  decideAction,
  rulesToLearn,
  type ClassificationContext
} from './classify.js'

const SCHOOL = 'school'

let store: Store
let context: ClassificationContext
let ecovi: string

beforeEach(() => {
  store = openStore(':memory:')

  ecovi = store.projects.create({
    name: 'GIS Applicatie EcoVi',
    organizationId: SYSTEM_ORGANIZATIONS.maasarend,
    areaId: SYSTEM_AREAS.stage
  }).id
  store.projects.create({
    name: 'SDSS De Margriet',
    organizationId: SYSTEM_ORGANIZATIONS.hasGreenAcademy,
    areaId: SCHOOL
  })

  context = readContext()
})

function readContext(): ClassificationContext {
  return {
    rules: store.calendarRules.list(),
    areas: store.areas.list(),
    organizations: store.organizations.list(),
    projects: store.projects.list(),
    workTypes: store.workTypes.list()
  }
}

describe('what it can work out on its own', () => {
  it('recognises a project by name, and takes its organization and area with it', () => {
    const result = classify({ title: 'Projectoverleg GIS Applicatie EcoVi' }, context)

    expect(result.projectId).toBe(ecovi)
    expect(result.organizationId).toBe(SYSTEM_ORGANIZATIONS.maasarend)
    expect(result.areaId).toBe(SYSTEM_AREAS.stage)
    expect(result.reasons.join(' ')).toContain('GIS Applicatie EcoVi')
  })

  it('recognises an organization on its own', () => {
    const result = classify({ title: 'Overleg Maasarend' }, context)
    expect(result.organizationId).toBe(SYSTEM_ORGANIZATIONS.maasarend)
  })

  it('picks up the work type from the words used', () => {
    const result = classify({ title: 'Projectoverleg EcoVi — meeting' }, context)
    expect(result.workTypeId).toBe('work-type-meeting')
  })

  it('is not confident about something vague', () => {
    const result = classify({ title: 'Appointment' }, context)

    expect(result.confidence).toBeLessThan(LOW_CONFIDENCE)
    expect(result.areaId).toBeNull()
  })

  it('refuses to be confident without an area, however much else matched', () => {
    // An organization with no area attached: interesting, but it decides no hours.
    store.projects.create({ name: 'Loose Ends', organizationId: SYSTEM_ORGANIZATIONS.jumbo })
    const result = classify({ title: 'Loose Ends catch-up' }, readContext())

    expect(result.areaId).toBeNull()
    expect(result.confidence).toBeLessThan(LOW_CONFIDENCE)
  })
})

describe('the calendar it arrived in', () => {
  const calendar = (defaults: Partial<CalendarSource>): CalendarSource => ({
    id: 'cal-1',
    accountId: 'acc-1',
    externalId: 'ext-1',
    name: 'HAS Calendar',
    color: null,
    selected: true,
    writable: false,
    defaultAreaId: null,
    defaultOrganizationId: null,
    defaultProjectId: null,
    defaultWorkTypeId: null,
    ignoreForPlanning: false,
    ...defaults
  })

  it('trusts a calendar default more than a guess from words', () => {
    const result = classify(
      { title: 'Lecture', calendar: calendar({ defaultAreaId: SCHOOL }) },
      context
    )

    expect(result.areaId).toBe(SCHOOL)
    expect(result.confidence).toBeGreaterThanOrEqual(HIGH_CONFIDENCE - 40)
    expect(result.reasons.join(' ')).toContain('HAS Calendar')
  })

  it('lets a stronger signal fill what the calendar left blank', () => {
    const result = classify(
      {
        title: 'Projectoverleg GIS Applicatie EcoVi',
        calendar: calendar({ defaultAreaId: SYSTEM_AREAS.stage })
      },
      context
    )

    expect(result.areaId).toBe(SYSTEM_AREAS.stage)
    expect(result.projectId).toBe(ecovi)
    // Calendar default plus a project match is enough to stop asking.
    expect(result.confidence).toBeGreaterThanOrEqual(HIGH_CONFIDENCE)
  })
})

describe('learning from corrections', () => {
  it('grows more confident the more often the same choice is confirmed', () => {
    const learn = (): void => {
      store.calendarRules.learn({
        matcher: 'title',
        pattern: 'ecovi',
        areaId: SYSTEM_AREAS.stage,
        organizationId: SYSTEM_ORGANIZATIONS.maasarend,
        projectId: ecovi,
        workTypeId: 'work-type-meeting'
      })
    }

    learn()
    const once = classify({ title: 'Ecovi' }, readContext()).confidence

    learn()
    learn()
    const thrice = classify({ title: 'Ecovi' }, readContext()).confidence

    expect(thrice).toBeGreaterThan(once)
  })

  it('follows the latest correction rather than the old one', () => {
    store.calendarRules.learn({ matcher: 'title', pattern: 'margriet', areaId: SYSTEM_AREAS.stage })
    store.calendarRules.learn({ matcher: 'title', pattern: 'margriet', areaId: SCHOOL })

    expect(classify({ title: 'Margriet overleg' }, readContext()).areaId).toBe(SCHOOL)
  })

  it('stops applying a rule that has been forgotten', () => {
    const rule = store.calendarRules.learn({
      matcher: 'title',
      pattern: 'zumba',
      areaId: SYSTEM_AREAS.personal
    })
    expect(classify({ title: 'Zumba' }, readContext()).areaId).toBe(SYSTEM_AREAS.personal)

    store.calendarRules.forget(rule.id)
    expect(classify({ title: 'Zumba' }, readContext()).areaId).toBeNull()
  })

  it('learns words that identify the work, not words every meeting has', () => {
    const patterns = rulesToLearn(
      { title: 'Projectoverleg Maasarend EcoVi', location: 'Teams' },
      {
        areaId: SYSTEM_AREAS.stage,
        organizationId: SYSTEM_ORGANIZATIONS.maasarend,
        projectId: ecovi,
        workTypeId: null
      }
    ).map((rule) => rule.pattern)

    expect(patterns).toContain('maasarend')
    expect(patterns).toContain('ecovi')
    // "overleg" would classify every meeting you ever have as internship work.
    expect(patterns).not.toContain('overleg')
  })

  it('learns nothing from a classification that says nothing', () => {
    expect(
      rulesToLearn(
        { title: 'Something' },
        { areaId: null, organizationId: null, projectId: null, workTypeId: null }
      )
    ).toEqual([])
  })
})

describe('when to interrupt', () => {
  it('classifies silently when sure, suggests when unsure, asks when lost', () => {
    expect(decideAction(95, 'ask-when-uncertain')).toBe('classify')
    expect(decideAction(60, 'ask-when-uncertain')).toBe('suggest')
    expect(decideAction(10, 'ask-when-uncertain')).toBe('ask')
  })

  it('respects the threshold you set', () => {
    expect(decideAction(85, 'ask-when-uncertain', 90)).toBe('suggest')
    expect(decideAction(85, 'ask-when-uncertain', 80)).toBe('classify')
  })

  it('always asks when told to, and never classifies when told not to', () => {
    expect(decideAction(99, 'always-ask')).toBe('suggest')
    expect(decideAction(99, 'never')).toBe('ask')
  })
})
