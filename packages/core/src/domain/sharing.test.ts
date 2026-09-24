/**
 * Who may see what, with the real seeded areas.
 *
 * The rule these prove is that an audience is not a single "is this shareable" flag: the
 * internship supervisor and the teacher are asked separately, and School answers them
 * differently on purpose. Everything Maasarend is not automatically supervisor material,
 * and everything at the school is not automatically the supervisor's business at all.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { openStore, type Store } from '../db/index.js'
import { SYSTEM_AREAS, SYSTEM_ORGANIZATIONS } from '../contract/types.js'
import { resolveAreaId, sharesWithSupervisor, sharesWithTeacher } from './sharing.js'

const SCHOOL = 'school'

let store: Store

beforeEach(() => {
  store = openStore(':memory:')
})

/** Resolves a task the way every caller does: its own area, else its project's. */
function context(taskId: string): { area: ReturnType<Store['areas']['get']>; project: ReturnType<Store['projects']['get']> } {
  const task = store.tasks.get(taskId)!
  const project = task.projectId ? store.projects.get(task.projectId) : null
  const areaId = resolveAreaId(task, project)
  return { area: areaId ? store.areas.get(areaId) : null, project }
}

function task(title: string, areaId: string, organizationId: string, shareable = true): string {
  const project = store.projects.create({ name: `${title} project`, organizationId, shareable })
  return store.tasks.create({ title, areaId, projectId: project.id }).id
}

describe('the internship supervisor', () => {
  it('sees Stage work for Maasarend when the project allows it', () => {
    const id = task('Internship analysis', SYSTEM_AREAS.stage, SYSTEM_ORGANIZATIONS.maasarend)
    expect(sharesWithSupervisor(context(id))).toBe(true)
  })

  it('does not see Work for the same organization, however shareable the project is', () => {
    const id = task('Paid extra work', SYSTEM_AREAS.work, SYSTEM_ORGANIZATIONS.maasarend, true)
    // Same employer, same project flag — the area is what decides, and Work says no.
    expect(sharesWithSupervisor(context(id))).toBe(false)
  })

  it('does not see School work', () => {
    const id = task('Examination preparation', SCHOOL, SYSTEM_ORGANIZATIONS.hasGreenAcademy)
    expect(sharesWithSupervisor(context(id))).toBe(false)
  })

  it('does not see Personal work', () => {
    const id = task('Errand', SYSTEM_AREAS.personal, SYSTEM_ORGANIZATIONS.maasarend)
    expect(sharesWithSupervisor(context(id))).toBe(false)
  })

  it('loses access when the project narrows what the area allows', () => {
    const id = task('Confidential internship work', SYSTEM_AREAS.stage, SYSTEM_ORGANIZATIONS.maasarend, false)
    expect(sharesWithSupervisor(context(id))).toBe(false)
  })
})

describe('the teacher', () => {
  it('sees School work at HAS Green Academy', () => {
    const id = task('Examination preparation', SCHOOL, SYSTEM_ORGANIZATIONS.hasGreenAcademy)
    expect(sharesWithTeacher(context(id))).toBe(true)
  })

  it('sees internship progress, which the programme asks for', () => {
    const id = task('Internship analysis', SYSTEM_AREAS.stage, SYSTEM_ORGANIZATIONS.maasarend)
    expect(sharesWithTeacher(context(id))).toBe(true)
  })

  it('does not see Work for Maasarend', () => {
    const id = task('Paid extra work', SYSTEM_AREAS.work, SYSTEM_ORGANIZATIONS.maasarend)
    expect(sharesWithTeacher(context(id))).toBe(false)
  })

  it('does not see Personal work', () => {
    const id = task('Errand', SYSTEM_AREAS.personal, SYSTEM_ORGANIZATIONS.maasarend)
    expect(sharesWithTeacher(context(id))).toBe(false)
  })
})

describe('the two audiences are decided separately', () => {
  it('gives School to the teacher and not to the supervisor', () => {
    const id = task('Portfolio work', SCHOOL, SYSTEM_ORGANIZATIONS.hasGreenAcademy)
    const ctx = context(id)

    expect(sharesWithTeacher(ctx)).toBe(true)
    expect(sharesWithSupervisor(ctx)).toBe(false)
  })

  it('treats an unknown area as permission for nobody', () => {
    const project = store.projects.create({
      name: 'Loose project',
      organizationId: SYSTEM_ORGANIZATIONS.maasarend,
      shareable: true
    })
    const id = store.tasks.create({ title: 'Unclassified', projectId: project.id, areaId: null }).id

    expect(sharesWithSupervisor(context(id))).toBe(false)
    expect(sharesWithTeacher(context(id))).toBe(false)
  })
})
