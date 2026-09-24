/**
 * ★ Every Dutch string the supervisor ever sees. ★
 *
 * docx.ts must not contain a single literal — it asks this file for text. That is what
 * makes a second language a one-file change instead of a hunt through the codebase, and
 * it is also the only practical way to proofread the report as a whole.
 */

import { formatDateRange, formatLongDate, formatWeekLabel } from '../i18n/format.js'
import type { IsoDate, IsoWeek, Priority, TaskStatus } from '../contract/types.js'

export const nl = {
  // ---------------------------------------------------------------- document
  documentTitle: (week: IsoWeek) => `Weekrapport ${formatWeekLabel(week).toLowerCase()}`,
  fileName: (week: IsoWeek) => `Weekrapport-${week.replace('-W', '-week-')}.docx`,
  period: (from: IsoDate, to: IsoDate) => `Periode: ${formatDateRange(from, to)}`,
  generatedOn: (at: number) => `Opgesteld op ${formatLongDate(at)}`,
  author: 'Stagerapportage',

  // ---------------------------------------------------------------- sections
  sections: {
    summary: 'Samenvatting',
    hours: 'Urenoverzicht',
    completed: 'Afgeronde taken',
    screenshots: 'Beeldmateriaal',
    timelapse: 'Timelapse',
    nextWeek: 'Planning komende week'
  },

  // ------------------------------------------------------------------ tables
  table: {
    task: 'Taak',
    project: 'Project',
    /** The first accepted plan of the week, before any replanning. */
    baseline: 'Oorspronkelijk',
    planned: 'Gepland',
    actual: 'Werkelijk',
    difference: 'Verschil',
    status: 'Status',
    total: 'Totaal',
    day: 'Dag',
    time: 'Tijd',
    date: 'Datum'
  },

  status: {
    open: 'Open',
    in_progress: 'Mee bezig',
    blocked: 'Geblokkeerd',
    done: 'Afgerond',
    archived: 'Gearchiveerd'
  } satisfies Record<TaskStatus, string>,

  priority: {
    high: 'Hoog',
    medium: 'Gemiddeld',
    low: 'Laag'
  } satisfies Record<Priority, string>,

  // ------------------------------------------------------------------ totals
  totals: {
    tracked: 'Totaal geregistreerd',
    planned: 'Totaal gepland',
    completedTasks: 'Afgeronde taken',
    plannedVsActual: 'Gepland versus werkelijk',
    focusBlocks: 'Focusblokken'
  },

  // ----------------------------------------------------------------- notices
  notice: {
    noSummary: 'Geen samenvatting ingevuld voor deze week.',
    noHours: 'Deze week zijn geen uren geregistreerd.',
    noCompleted: 'Deze week zijn geen taken afgerond.',
    noScreenshots: 'Voor deze week zijn geen schermafbeeldingen geselecteerd.',
    noTimelapse: 'Voor deze week is geen timelapse gemaakt.',
    noNextWeek: 'Voor komende week is nog niets ingepland.',
    screenshotCaption: (at: number) => `Schermafbeelding — ${formatLongDate(at)}`,
    timelapseNote: (fileName: string) =>
      `De timelapse van deze week is als los bestand meegestuurd: ${fileName}`,
    /** Stated in the document itself — the supervisor should know how this was produced. */
    method:
      'Uren zijn automatisch geregistreerd met een timer. Perioden van inactiviteit zijn ' +
      'niet meegeteld. Schermafbeeldingen zijn handmatig geselecteerd.',
    /**
     * Only printed when the week was actually replanned. Explaining a column that shows
     * the same number twice would be noise, and noise is how a report stops being read.
     */
    baselineExplained:
      '"Oorspronkelijk" is de planning zoals die aan het begin van de week is vastgelegd. ' +
      '"Gepland" is de planning zoals die er aan het eind van de week uitzag. Het verschil ' +
      'tussen die twee laat zien waar de week is bijgestuurd.',
    replannedTasks: (n: number) =>
      n === 1
        ? 'Eén taak is deze week opnieuw ingepland.'
        : `${n} taken zijn deze week opnieuw ingepland.`
  },

  // ------------------------------------------------------------------- email
  mail: {
    subject: (week: IsoWeek) => `Weekrapport ${formatWeekLabel(week).toLowerCase()}`,
    greeting: 'Beste',
    /** Used when no supervisor name is configured — better than a dangling "Beste ,". */
    fallbackName: 'begeleider',
    body: (week: IsoWeek) =>
      `Hierbij het weekrapport van ${formatWeekLabel(week).toLowerCase()}. ` +
      `In de bijlage vind je het volledige overzicht met de geregistreerde uren, ` +
      `de afgeronde taken en de planning voor komende week.`,
    closing: 'Met vriendelijke groet,'
  },

  // -------------------------------------------------------- summary prefill
  prefill: {
    intro: (weekLabel: string) => `In ${weekLabel.toLowerCase()} heb ik`,
    workedOn: (tasks: string) => `gewerkt aan ${tasks}`,
    completed: (n: number) => (n === 1 ? '1 taak afgerond' : `${n} taken afgerond`),
    tracked: (duration: string) => `In totaal is ${duration} geregistreerd`,
    onPlan: 'Dat komt overeen met de planning.',
    overPlan: (delta: string) => `Dat is ${delta} meer dan gepland.`,
    underPlan: (delta: string) => `Dat is ${delta} minder dan gepland.`,
    nextWeek: (tasks: string) => `Komende week staat gepland: ${tasks}.`,
    nextWeekEmpty: 'De planning voor komende week volgt nog.'
  }
} as const
