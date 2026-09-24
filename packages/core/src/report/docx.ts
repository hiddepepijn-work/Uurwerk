/**
 * Builds the Dutch weekly report document.
 *
 * Two deliberate constraints:
 *   1. Not one Dutch literal lives in this file — every string comes from nl.ts.
 *   2. This file never reads the disk. Image bytes are handed in by the main process,
 *      which keeps core filesystem-free and, more importantly, means the approval gate
 *      (`artifact.included`) is applied before any pixel gets near this code.
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} from 'docx'
import type { Artifact, IsoWeek, WeekReport } from '../contract/types.js'
import {
  formatDuration,
  formatLongDate,
  formatSignedDuration,
  formatWeekLabel
} from '../i18n/format.js'
import { fromIsoDate } from '../util/time.js'
import { nl } from './nl.js'

/** Image bytes keyed by artifact id, supplied by the caller. */
export type ImageBytes = Map<string, Uint8Array>

const ACCENT = '22C55E'
const MUTED = '6B7280'
const BORDER = 'D5D8DC'

const heading = (text: string): Paragraph =>
  new Paragraph({
    text,
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 160 }
  })

const body = (text: string, opts: { italic?: boolean; color?: string } = {}): Paragraph =>
  new Paragraph({
    children: [new TextRun({ text, italics: opts.italic ?? false, color: opts.color })],
    spacing: { after: 120 }
  })

const cell = (
  text: string,
  opts: { bold?: boolean; align?: (typeof AlignmentType)[keyof typeof AlignmentType]; color?: string } = {}
): TableCell =>
  new TableCell({
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    children: [
      new Paragraph({
        alignment: opts.align ?? AlignmentType.LEFT,
        children: [new TextRun({ text, bold: opts.bold ?? false, color: opts.color })]
      })
    ]
  })

const table = (rows: TableRow[]): Table =>
  new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 1, color: BORDER },
      bottom: { style: BorderStyle.SINGLE, size: 1, color: BORDER },
      left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: BORDER },
      insideVertical: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }
    },
    rows
  })

// ------------------------------------------------------------------ sections

/**
 * True when the week was actually replanned.
 *
 * The baseline column only earns its space if it says something different from the planned
 * one. On a week that went to plan the two are identical, and a column of repeated numbers
 * is how a report stops being read.
 */
export function wasReplanned(report: WeekReport): boolean {
  return report.rows.some((row) => row.baselineMin !== row.plannedMin)
}

function hoursSection(report: WeekReport): (Paragraph | Table)[] {
  if (report.rows.length === 0) return [body(nl.notice.noHours, { italic: true, color: MUTED })]

  const showBaseline = wasReplanned(report)
  const right = { align: AlignmentType.RIGHT }

  const header = new TableRow({
    tableHeader: true,
    children: [
      cell(nl.table.task, { bold: true }),
      cell(nl.table.project, { bold: true }),
      ...(showBaseline ? [cell(nl.table.baseline, { bold: true, ...right })] : []),
      cell(nl.table.planned, { bold: true, ...right }),
      cell(nl.table.actual, { bold: true, ...right }),
      cell(nl.table.difference, { bold: true, ...right }),
      cell(nl.table.status, { bold: true })
    ]
  })

  const rows = report.rows.map(
    (row) =>
      new TableRow({
        children: [
          cell(row.taskTitle),
          cell(row.projectName ?? '—'),
          ...(showBaseline
            ? [cell(formatDuration(row.baselineMin), { ...right, color: MUTED })]
            : []),
          cell(formatDuration(row.plannedMin), right),
          cell(formatDuration(row.actualMin), right),
          cell(formatSignedDuration(row.actualMin - row.plannedMin), { ...right, color: MUTED }),
          cell(nl.status[row.status], { color: row.status === 'done' ? ACCENT : undefined })
        ]
      })
  )

  const totalBaselineMin = report.rows.reduce((sum, row) => sum + row.baselineMin, 0)

  const totals = new TableRow({
    children: [
      cell(nl.table.total, { bold: true }),
      cell(''),
      ...(showBaseline
        ? [cell(formatDuration(totalBaselineMin), { bold: true, ...right, color: MUTED })]
        : []),
      cell(formatDuration(report.totalPlannedMin), { bold: true, ...right }),
      cell(formatDuration(report.totalTrackedMin), { bold: true, ...right }),
      cell(formatSignedDuration(report.totalTrackedMin - report.totalPlannedMin), {
        bold: true,
        ...right
      }),
      cell('')
    ]
  })

  const out: (Paragraph | Table)[] = [table([header, ...rows, totals])]

  if (showBaseline) {
    const changed = report.rows.filter((row) => row.baselineMin !== row.plannedMin).length
    out.push(
      new Paragraph({
        spacing: { before: 160 },
        children: [
          new TextRun({ text: nl.notice.replannedTasks(changed), size: 18, color: MUTED }),
          new TextRun({ text: ` ${nl.notice.baselineExplained}`, size: 18, color: MUTED })
        ]
      })
    )
  }

  return out
}

function screenshotSection(report: WeekReport, images: ImageBytes): Paragraph[] {
  // The approval gate. Excluded frames were never even read from disk by the caller.
  const included = report.screenshots.filter((shot) => shot.included && images.has(shot.id))
  if (included.length === 0) {
    return [body(nl.notice.noScreenshots, { italic: true, color: MUTED })]
  }

  return included.flatMap((shot: Artifact) => [
    new Paragraph({
      spacing: { before: 160, after: 40 },
      children: [
        new ImageRun({
          type: 'jpg',
          data: images.get(shot.id)!,
          transformation: { width: 560, height: 315 }
        })
      ]
    }),
    new Paragraph({
      spacing: { after: 160 },
      children: [
        new TextRun({ text: nl.notice.screenshotCaption(shot.capturedAt), size: 18, color: MUTED })
      ]
    })
  ])
}

function nextWeekSection(report: WeekReport): (Paragraph | Table)[] {
  if (report.nextWeekPlanning.length === 0) {
    return [body(nl.notice.noNextWeek, { italic: true, color: MUTED })]
  }

  const header = new TableRow({
    tableHeader: true,
    children: [
      cell(nl.table.day, { bold: true }),
      cell(nl.table.time, { bold: true }),
      cell(nl.table.task, { bold: true }),
      cell(nl.table.project, { bold: true })
    ]
  })

  const clock = (minutes: number): string =>
    `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`

  const rows = report.nextWeekPlanning.map(
    (block) =>
      new TableRow({
        children: [
          cell(formatLongDate(fromIsoDate(block.date))),
          cell(`${clock(block.startMin)} – ${clock(block.endMin)}`),
          cell(block.taskTitle),
          cell(block.projectName ?? '—')
        ]
      })
  )

  return [table([header, ...rows])]
}

// -------------------------------------------------------------------- public

export function buildReportDocument(
  report: WeekReport,
  week: IsoWeek,
  images: ImageBytes = new Map()
): Document {
  const children: (Paragraph | Table)[] = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun({ text: nl.documentTitle(week), bold: true })]
    }),
    body(nl.period(report.from, report.to), { color: MUTED }),
    body(nl.generatedOn(report.generatedAt), { color: MUTED }),

    heading(nl.sections.summary),
    body(report.summary.trim() || nl.notice.noSummary, {
      italic: report.summary.trim().length === 0,
      color: report.summary.trim() ? undefined : MUTED
    }),

    heading(nl.sections.hours),
    ...hoursSection(report),
    new Paragraph({
      spacing: { before: 120 },
      children: [
        new TextRun({
          text: `${nl.totals.completedTasks}: ${report.completedTasks} / ${report.totalTasks}`,
          size: 20
        })
      ]
    }),

    heading(nl.sections.screenshots),
    ...screenshotSection(report, images),

    heading(nl.sections.timelapse),
    report.timelapse
      ? body(nl.notice.timelapseNote(report.timelapse.path.split(/[\\/]/).pop() ?? ''))
      : body(nl.notice.noTimelapse, { italic: true, color: MUTED }),

    heading(nl.sections.nextWeek),
    ...nextWeekSection(report),

    new Paragraph({
      spacing: { before: 400 },
      children: [new TextRun({ text: nl.notice.method, size: 16, italics: true, color: MUTED })]
    })
  ]

  return new Document({
    creator: nl.author,
    title: nl.documentTitle(week),
    description: nl.period(report.from, report.to),
    sections: [{ children }]
  })
}

/** Convenience for the main process; kept here so docx stays a core-only dependency. */
export async function packDocument(doc: Document): Promise<Buffer> {
  return Packer.toBuffer(doc)
}

export const reportFileName = (week: IsoWeek): string => nl.fileName(week)
export const reportTitle = (week: IsoWeek): string => formatWeekLabel(week)
