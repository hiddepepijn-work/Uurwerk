/**
 * The covering e-mail for the weekly report.
 *
 * Plain text, not HTML. A supervisor reads this in whatever client they happen to use, on
 * whatever device, and a styled mail buys nothing that a clear one does not — while a
 * broken one costs the whole message.
 *
 * The numbers are repeated in the body on purpose. The attachment is the record, but the
 * mail is what actually gets read, so the three figures that matter are legible without
 * opening anything: hours registered, hours planned, tasks finished.
 *
 * Not one Dutch literal lives here either — everything comes from nl.ts, same rule as docx.
 */

import type { IsoWeek, WeekReport } from '../contract/types.js'
import { formatDuration, formatSignedDuration } from '../i18n/format.js'
import { nl } from './nl.js'

export interface MailDraft {
  to: string
  subject: string
  body: string
  /** Absolute path to the .docx. Null when no document has been generated yet. */
  attachmentPath: string | null
}

export interface MailOptions {
  to: string
  /** Blank is fine — the greeting falls back to a neutral form rather than an empty one. */
  supervisorName: string
  attachmentPath: string | null
}

export function buildWeekMail(
  report: WeekReport,
  week: IsoWeek,
  options: MailOptions
): MailDraft {
  const delta = report.totalTrackedMin - report.totalPlannedMin

  const lines: string[] = [
    `${nl.mail.greeting} ${options.supervisorName.trim() || nl.mail.fallbackName},`,
    '',
    nl.mail.body(week),
    '',
    `${nl.totals.tracked}: ${formatDuration(report.totalTrackedMin)}`,
    `${nl.totals.planned}: ${formatDuration(report.totalPlannedMin)}` +
      (report.totalPlannedMin > 0 ? ` (${formatSignedDuration(delta)})` : ''),
    `${nl.totals.completedTasks}: ${report.completedTasks} / ${report.totalTasks}`
  ]

  // The summary is the part a supervisor actually reads, so it goes in the mail itself
  // rather than only in the attachment they may never open.
  const summary = report.summary.trim()
  if (summary) lines.push('', summary)

  lines.push('', nl.mail.closing)

  return {
    to: options.to,
    subject: nl.mail.subject(week),
    body: lines.join('\n'),
    attachmentPath: options.attachmentPath
  }
}

/**
 * A `mailto:` URL for draft mode.
 *
 * Deliberately carries no attachment: `mailto` cannot attach a file, and every trick that
 * claims to either does not work outside one specific client or silently drops it. The
 * caller reveals the .docx in the file manager instead, so attaching it is one drag rather
 * than a hunt — an honest two-step beats a one-step that quietly sends an empty report.
 */
export function mailtoUrl(draft: MailDraft): string {
  const query = new URLSearchParams({ subject: draft.subject, body: draft.body })
  // URLSearchParams encodes spaces as '+', which mail clients render literally.
  return `mailto:${encodeURIComponent(draft.to)}?${query.toString().replace(/\+/g, '%20')}`
}
