/**
 * Prefills the supervisor summary box.
 *
 * This writes a first draft from the week's numbers — it is not meant to be sent as-is.
 * The numbers prove *what* happened; your own sentences explain *why*, and that is the
 * part a supervisor actually reads. The box stays editable and the draft stays short.
 */

import type { IsoWeek, WeekReport } from '../contract/types.js'
import { formatDuration, formatSignedDuration, formatList, formatWeekLabel } from '../i18n/format.js'
import { nl } from './nl.js'

export const SUMMARY_MAX_CHARS = 1000

export function prefillSummary(report: WeekReport, week: IsoWeek): string {
  const worked = report.rows.filter((row) => row.actualMin > 0)
  if (worked.length === 0) return nl.notice.noHours

  const p = nl.prefill
  const sentences: string[] = []

  // 1. What was worked on — the three biggest items, by time.
  const top = worked
    .slice(0, 3)
    .map((row) => (row.projectName ? `${row.taskTitle} (${row.projectName})` : row.taskTitle))
  const completed = report.completedTasks > 0 ? `, en ${p.completed(report.completedTasks)}` : ''
  sentences.push(`${p.intro(formatWeekLabel(week))} ${p.workedOn(formatList(top))}${completed}.`)

  // 2. Hours, and how they relate to the plan.
  const delta = report.totalTrackedMin - report.totalPlannedMin
  const tracked = p.tracked(formatDuration(report.totalTrackedMin))
  let comparison: string = p.onPlan
  if (report.totalPlannedMin > 0) {
    // Within 15 minutes is "as planned" — anything tighter is noise, not information.
    if (delta > 15) comparison = p.overPlan(formatSignedDuration(delta).replace('+', ''))
    else if (delta < -15) comparison = p.underPlan(formatDuration(Math.abs(delta)))
  }
  sentences.push(`${tracked}. ${comparison}`)

  // 3. What is coming.
  const upcoming = [...new Set(report.nextWeekPlanning.map((block) => block.taskTitle))].slice(0, 3)
  sentences.push(upcoming.length > 0 ? p.nextWeek(formatList(upcoming)) : p.nextWeekEmpty)

  return sentences.join(' ').slice(0, SUMMARY_MAX_CHARS)
}
