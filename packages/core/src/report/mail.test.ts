import { describe, expect, it } from 'vitest'
import type { WeekReport } from '../contract/types.js'
import { buildWeekMail, mailtoUrl } from './mail.js'

const week = '2026-W32'

function report(overrides: Partial<WeekReport> = {}): WeekReport {
  return {
    week,
    from: '2026-08-03',
    to: '2026-08-09',
    generatedAt: Date.now(),
    rows: [],
    totalPlannedMin: 20 * 60,
    totalTrackedMin: 22 * 60,
    completedTasks: 4,
    totalTasks: 6,
    screenshots: [],
    timelapse: null,
    summary: '',
    nextWeekPlanning: [],
    docxPath: 'C:/rapporten/Weekrapport-2026-week-32.docx',
    sentAt: null,
    ...overrides
  }
}

const options = { to: 'begeleider@example.com', supervisorName: 'Margriet', attachmentPath: null }

describe('the covering mail', () => {
  it('addresses the supervisor by name', () => {
    expect(buildWeekMail(report(), week, options).body).toContain('Beste Margriet,')
  })

  it('falls back to a neutral greeting rather than a dangling comma', () => {
    const draft = buildWeekMail(report(), week, { ...options, supervisorName: '   ' })
    expect(draft.body).toContain('Beste begeleider,')
    expect(draft.body).not.toContain('Beste ,')
  })

  it('carries the three numbers that matter, without opening the attachment', () => {
    const body = buildWeekMail(report(), week, options).body

    expect(body).toContain('Totaal geregistreerd: 22u')
    expect(body).toContain('Totaal gepland: 20u')
    // Signed, so over and under are readable at a glance rather than needing arithmetic.
    expect(body).toContain('(+2u)')
    expect(body).toContain('Afgeronde taken: 4 / 6')
  })

  it('leaves the comparison out when nothing was planned', () => {
    const body = buildWeekMail(report({ totalPlannedMin: 0 }), week, options).body
    expect(body).toContain('Totaal gepland: 0m')
    expect(body).not.toMatch(/\([+-]/)
  })

  it('includes the week summary, which is the part that gets read', () => {
    const body = buildWeekMail(
      report({ summary: 'Deze week vooral aan de kaartlaag gewerkt.' }),
      week,
      options
    ).body

    expect(body).toContain('Deze week vooral aan de kaartlaag gewerkt.')
  })

  it('writes a Dutch subject naming the week', () => {
    expect(buildWeekMail(report(), week, options).subject).toBe('Weekrapport week 32')
  })
})

describe('the mailto url', () => {
  it('encodes the recipient, subject and body', () => {
    const url = mailtoUrl(buildWeekMail(report(), week, options))

    expect(url.startsWith('mailto:begeleider%40example.com?')).toBe(true)
    expect(url).toContain('subject=Weekrapport%20week%2032')
    expect(url).toContain('body=Beste%20Margriet')
  })

  it('never encodes a space as a plus, which clients render literally', () => {
    const url = mailtoUrl(buildWeekMail(report(), week, options))
    expect(url).not.toContain('+')
  })
})
