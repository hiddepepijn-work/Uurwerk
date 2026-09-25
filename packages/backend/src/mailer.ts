/**
 * Sending the weekly report.
 *
 * Two modes, and the difference between them is who presses send:
 *
 *   draft — opens your mail client with the message already written and reveals the .docx
 *           in Explorer so you can attach it. Nothing leaves the machine until you send it.
 *           This is the default, and it is the mode that needs no credentials at all.
 *
 *   smtp  — hands the message and the attachment to your mail server directly. Faster, and
 *           the only mode that can honestly stamp `sent_at`, but it needs a password in the
 *           vault and a server that will accept it.
 *
 * Both refuse loudly rather than half-working: no recipient, no document, no credentials —
 * each of those is an error with a sentence saying what to fix, never a silent no-op that
 * leaves you believing your supervisor got something.
 */

import { existsSync } from 'node:fs'
import { basename } from 'node:path'

import type { SendOutcome } from '@core/contract/api.js'
import type { IsoWeek } from '@core/contract/types.js'
import { buildWeekMail, mailtoUrl } from '@core/report/mail.js'

import type { Backend } from './create.js'
import { log } from './log.js'
import { host } from './host.js'

export async function sendWeekReport(backend: Backend, week: IsoWeek): Promise<SendOutcome> {
  const settings = backend.store.settings.get()
  const report = backend.reports.build(week)

  const to = settings.supervisorEmail.trim()
  if (!to) {
    throw new Error('No supervisor e-mail address is set. Add one under Settings → Reports.')
  }

  // The document is the report; a covering mail without it is just a note.
  const attachmentPath = report.docxPath
  if (!attachmentPath || !existsSync(attachmentPath)) {
    throw new Error(
      'There is no document for this week yet. Press "Generate .docx" first — the mail carries it as an attachment.'
    )
  }

  const draft = buildWeekMail(report, week, {
    to,
    supervisorName: settings.supervisorName,
    attachmentPath
  })

  if (settings.mailMode === 'smtp') {
    await sendOverSmtp(settings, draft, attachmentPath)
    backend.store.reports.markSent(week)
    log.info('Weekly report sent over SMTP.', { week, to })
    return {
      mode: 'smtp',
      sent: true,
      message: `Sent to ${to} with ${basename(attachmentPath)} attached.`
    }
  }

  await host().openExternal(mailtoUrl(draft))
  // mailto cannot carry a file, so the next best thing is putting it under the cursor.
  host().showItemInFolder(attachmentPath)
  log.info('Weekly report opened as a draft.', { week, to })

  return {
    mode: 'draft',
    sent: false,
    message: `Draft opened for ${to}. Attach ${basename(attachmentPath)} — it is highlighted in Explorer — and send it yourself.`
  }
}

async function sendOverSmtp(
  settings: { smtpHost: string; smtpPort: number; smtpUser: string; supervisorEmail: string },
  draft: { to: string; subject: string; body: string },
  attachmentPath: string
): Promise<void> {
  if (!settings.smtpHost.trim() || !settings.smtpUser.trim()) {
    throw new Error('SMTP is selected but the server or the username is missing. Check Settings → Reports.')
  }

  const password = host().secrets.get('smtpPassword')
  if (!password) {
    throw new Error(
      'No SMTP password is stored. Enter it under Settings → Reports, or switch to draft mode.'
    )
  }

  // Imported here rather than at the top: nothing else in the app needs nodemailer, and
  // draft mode must not pay for loading it.
  const { createTransport } = await import('nodemailer')

  const transport = createTransport({
    host: settings.smtpHost.trim(),
    port: settings.smtpPort,
    // 465 is implicit TLS; 587 and 25 start plain and upgrade with STARTTLS.
    secure: settings.smtpPort === 465,
    auth: { user: settings.smtpUser.trim(), pass: password }
  })

  // Fails on a bad host, port or password before a message is queued, which turns a silent
  // "nothing arrived" into a readable error at the moment you press the button.
  await transport.verify()

  await transport.sendMail({
    from: settings.smtpUser.trim(),
    to: draft.to,
    subject: draft.subject,
    text: draft.body,
    attachments: [{ filename: basename(attachmentPath), path: attachmentPath }]
  })

  transport.close()
}
