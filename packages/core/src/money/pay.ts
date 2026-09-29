/**
 * What one shift earns.
 *
 * Premiums are paid per hour, not per shift: a late shift 17:30–01:00 is partly basic rate,
 * partly +20% (21:00–00:00) and partly +30% (00:00–06:00). So the shift is walked minute by
 * minute — at most 24 × 60 steps, and nothing about it is clever enough to get wrong.
 *
 * The unpaid break comes out of the window it falls in, which is why a template says when the
 * break starts: fifty minutes at 03:00 costs more than fifty minutes at 19:00.
 */

import type { PayProfile, ShiftTemplate } from '../contract/types.js'

export interface ShiftPay {
  paidMinutes: number
  /** Paid minutes per premium percentage, 0 = basic rate. */
  minutesByPercent: Record<number, number>
  grossCents: number
  netCents: number
  travelCents: number
  /** Net plus travel: what lands on the account for this shift. */
  totalCents: number
}

export function clockMinutes(clock: string): number {
  const [h, m] = clock.split(':').map(Number)
  return h! * 60 + (m ?? 0)
}

/** The premium for a minute of the day (0–1439): the highest window that covers it. */
function premiumAt(profile: PayProfile, minuteOfDay: number): number {
  let best = 0
  for (const window of profile.premiums) {
    const from = clockMinutes(window.from)
    const to = clockMinutes(window.to)
    const inside = from <= to ? minuteOfDay >= from && minuteOfDay < to : minuteOfDay >= from || minuteOfDay < to
    if (inside && window.percent > best) best = window.percent
  }
  return best
}

export function shiftPay(profile: PayProfile, template: ShiftTemplate): ShiftPay {
  const start = clockMinutes(template.start)
  let end = clockMinutes(template.end)
  if (end <= start) end += 24 * 60
  // The break sits inside the shift: 03:00 in a night shift is the next day.
  let breakStart = clockMinutes(template.breakAt)
  if (breakStart < start) breakStart += 24 * 60
  const breakEnd = breakStart + template.breakMinutes

  const minutesByPercent: Record<number, number> = {}
  let weighted = 0
  let paidMinutes = 0
  for (let minute = start; minute < end; minute += 1) {
    if (minute >= breakStart && minute < breakEnd) continue
    const percent = premiumAt(profile, minute % (24 * 60))
    minutesByPercent[percent] = (minutesByPercent[percent] ?? 0) + 1
    weighted += 1 + percent / 100
    paidMinutes += 1
  }

  const grossCents = Math.round((weighted / 60) * profile.hourlyCents)
  const netCents = Math.round(grossCents * profile.netFactor)
  const travelCents = Math.round(2 * profile.kmOneWay * profile.kmCents)
  return { paidMinutes, minutesByPercent, grossCents, netCents, travelCents, totalCents: netCents + travelCents }
}

export function templateFor(profile: PayProfile, key: string): ShiftTemplate | null {
  return profile.templates.find((template) => template.key === key) ?? null
}

/** What a shift of this template brings in, net plus travel; 0 for an unknown template. */
export function shiftTotal(profile: PayProfile, key: string): number {
  const template = templateFor(profile, key)
  return template ? shiftPay(profile, template).totalCents : 0
}
