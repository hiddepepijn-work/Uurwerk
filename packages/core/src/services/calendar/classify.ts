/**
 * Guessing what an appointment is, from evidence that is already on the machine.
 *
 * No model, no upload, nothing that needs explaining to a privacy policy: an event title is
 * matched against the names you already use — your organizations, projects and areas — and
 * against the rules learned from corrections you made yourself. Every guess can be read back
 * as a sentence, which is what makes it arguable instead of magic.
 *
 * Confidence is the point of the whole exercise. It decides whether you are interrupted:
 * high enough and the event is classified with a notification, middling and the popup opens
 * with the guess filled in, low and the popup asks. So it has to be honest — a scorer that
 * flatters itself produces a stream of silently miscategorised hours, which is worse than
 * asking.
 *
 * Two habits keep it honest:
 *   - a rule earns confidence by being confirmed repeatedly, and cannot start out certain
 *   - a calendar's own default is trusted more than a keyword, because you set it deliberately
 */

import type {
  Area,
  CalendarSource,
  ClassificationRule,
  ClassificationSuggestion,
  Organization,
  Project,
  WorkType
} from '../../contract/types.js'

/** What the classifier is allowed to look at. Deliberately small and local. */
export interface ClassifiableEvent {
  title: string
  location?: string | null
  organizer?: string | null
  attendees?: string[]
  /** The calendar it arrived in, if any — its defaults are the strongest signal. */
  calendar?: CalendarSource | null
}

export interface ClassificationContext {
  rules: ClassificationRule[]
  areas: Area[]
  organizations: Organization[]
  projects: Project[]
  workTypes: WorkType[]
}

/**
 * Weights, in one place so the ranking can be argued with.
 *
 * A calendar default outranks everything because it is a standing instruction. A confirmed
 * rule comes next, growing with use but capped — twenty confirmations is not proof. Names
 * matched out of your own data are good evidence but not a decision, and a work type guessed
 * from a word like "meeting" is the weakest thing here.
 */
export const WEIGHTS = {
  /**
   * The heaviest single fact, and it earns that on purpose.
   *
   * Per-calendar defaults exist precisely so a calendar that is only ever school work stops
   * producing prompts. Set at 55 rather than 45 so that a default plus one other solid
   * signal — a project named in the title — clears the auto-classify bar, while a default on
   * its own still only pre-fills the popup, because knowing the area is not knowing the work.
   */
  calendarDefault: 55,
  rulePerHit: 12,
  ruleMax: 40,
  organizationName: 20,
  projectName: 25,
  areaName: 10,
  workTypeWord: 8
} as const

/** Above this, classify without asking. */
export const HIGH_CONFIDENCE = 80
/** Below this, do not pre-fill a guess — ask outright. */
export const LOW_CONFIDENCE = 35

const normalise = (value: string): string => value.toLowerCase().trim()

/** Substring, case-insensitive, and never on a blank needle — the capture blocklist rule. */
function mentions(haystack: string, needle: string): boolean {
  const cleaned = normalise(needle)
  if (cleaned.length < 3) return false
  return haystack.includes(cleaned)
}

interface Accumulator {
  areaId: string | null
  organizationId: string | null
  projectId: string | null
  workTypeId: string | null
  score: number
  reasons: string[]
  usedRuleIds: string[]
}

export interface ClassificationResult extends ClassificationSuggestion {
  /** Rules that contributed, so their `last_used_at` can be stamped. */
  usedRuleIds: string[]
}

export function classify(
  event: ClassifiableEvent,
  context: ClassificationContext
): ClassificationResult {
  const haystack = [event.title, event.location ?? '', event.organizer ?? '', ...(event.attendees ?? [])]
    .map(normalise)
    .join(' · ')

  const state: Accumulator = {
    areaId: null,
    organizationId: null,
    projectId: null,
    workTypeId: null,
    score: 0,
    reasons: [],
    usedRuleIds: []
  }

  // 1. The calendar's own defaults. You set these deliberately, so they lead.
  const calendar = event.calendar
  if (calendar) {
    let applied = false
    if (calendar.defaultAreaId) {
      state.areaId = calendar.defaultAreaId
      applied = true
    }
    if (calendar.defaultOrganizationId) {
      state.organizationId = calendar.defaultOrganizationId
      applied = true
    }
    if (calendar.defaultProjectId) {
      state.projectId = calendar.defaultProjectId
      applied = true
    }
    if (calendar.defaultWorkTypeId) {
      state.workTypeId = calendar.defaultWorkTypeId
      applied = true
    }
    if (applied) {
      state.score += WEIGHTS.calendarDefault
      state.reasons.push(`Everything from “${calendar.name}” is classified this way`)
    }
  }

  // 2. Learned rules, strongest first, filling only what is still unknown.
  for (const rule of [...context.rules].sort((a, b) => b.hits - a.hits)) {
    const field =
      rule.matcher === 'calendar'
        ? normalise(calendar?.name ?? '')
        : rule.matcher === 'location'
          ? normalise(event.location ?? '')
          : rule.matcher === 'organizer'
            ? normalise(event.organizer ?? '')
            : rule.matcher === 'attendee'
              ? (event.attendees ?? []).map(normalise).join(' ')
              : normalise(event.title)

    if (!field || !mentions(field, rule.pattern)) continue

    const filled = fill(state, rule)
    if (!filled) continue

    state.score += Math.min(WEIGHTS.ruleMax, rule.hits * WEIGHTS.rulePerHit)
    state.usedRuleIds.push(rule.id)
    state.reasons.push(
      rule.hits === 1
        ? `“${rule.pattern}” was classified this way once before`
        : `“${rule.pattern}” has been classified this way ${rule.hits} times`
    )
  }

  // 3. Your own names, found in the text. A project names its organization and area too,
  //    which is why it is worth more than either on its own.
  for (const project of context.projects) {
    if (!mentions(haystack, project.name)) continue
    if (!state.projectId) {
      state.projectId = project.id
      state.score += WEIGHTS.projectName
      state.reasons.push(`Mentions the project “${project.name}”`)
    }
    if (!state.organizationId && project.organizationId) state.organizationId = project.organizationId
    if (!state.areaId && project.areaId) state.areaId = project.areaId
    break
  }

  for (const organization of context.organizations) {
    if (!mentions(haystack, organization.name)) continue
    if (!state.organizationId) {
      state.organizationId = organization.id
      state.score += WEIGHTS.organizationName
      state.reasons.push(`Mentions ${organization.name}`)
    }
    break
  }

  for (const area of context.areas) {
    if (!mentions(haystack, area.name)) continue
    if (!state.areaId) {
      state.areaId = area.id
      state.score += WEIGHTS.areaName
      state.reasons.push(`Mentions ${area.name}`)
    }
    break
  }

  // 4. The weakest signal: an activity word in the title.
  if (!state.workTypeId) {
    for (const workType of context.workTypes) {
      if (!mentions(haystack, workType.name) && !mentions(haystack, workType.slug)) continue
      state.workTypeId = workType.id
      state.score += WEIGHTS.workTypeWord
      state.reasons.push(`Looks like ${workType.name.toLowerCase()}`)
      break
    }
  }

  return {
    areaId: state.areaId,
    organizationId: state.organizationId,
    projectId: state.projectId,
    workTypeId: state.workTypeId,
    // An area is the one field that matters for hours, so a guess without one is not a
    // guess worth acting on however much else matched.
    confidence: state.areaId === null ? Math.min(state.score, LOW_CONFIDENCE - 1) : Math.min(100, state.score),
    reasons: state.reasons,
    usedRuleIds: state.usedRuleIds
  }
}

/** Fills only the blanks: an earlier, stronger signal is never overwritten by a weaker one. */
function fill(state: Accumulator, rule: ClassificationRule): boolean {
  let filled = false
  if (!state.areaId && rule.areaId) {
    state.areaId = rule.areaId
    filled = true
  }
  if (!state.organizationId && rule.organizationId) {
    state.organizationId = rule.organizationId
    filled = true
  }
  if (!state.projectId && rule.projectId) {
    state.projectId = rule.projectId
    filled = true
  }
  if (!state.workTypeId && rule.workTypeId) {
    state.workTypeId = rule.workTypeId
    filled = true
  }
  return filled
}

export type ClassificationAction = 'classify' | 'suggest' | 'ask'

/**
 * What to do with a guess, given how sure it is and what you asked for.
 *
 * `askBelow` is the threshold from Settings; the behaviour setting can override the whole
 * question in either direction.
 */
export function decideAction(
  confidence: number,
  behaviour: 'automatic' | 'ask-when-uncertain' | 'always-ask' | 'never',
  askBelow = HIGH_CONFIDENCE
): ClassificationAction {
  if (behaviour === 'never') return 'ask'
  if (behaviour === 'always-ask') return confidence >= LOW_CONFIDENCE ? 'suggest' : 'ask'
  if (behaviour === 'automatic') return confidence >= LOW_CONFIDENCE ? 'classify' : 'ask'

  if (confidence >= askBelow) return 'classify'
  if (confidence >= LOW_CONFIDENCE) return 'suggest'
  return 'ask'
}

/**
 * The rules to write when a classification is confirmed and you asked it to be remembered.
 *
 * Keywords come from the title, minus the words that describe every meeting anyone has ever
 * had — remembering that "meeting" means Stage would classify your dentist as internship work.
 */
export function rulesToLearn(
  event: ClassifiableEvent,
  choice: { areaId: string | null; organizationId: string | null; projectId: string | null; workTypeId: string | null }
): Array<{ matcher: 'title' | 'location'; pattern: string }> {
  const out: Array<{ matcher: 'title' | 'location'; pattern: string }> = []
  if (!choice.areaId && !choice.projectId && !choice.organizationId) return out

  const STOP_WORDS = new Set([
    'meeting',
    'overleg',
    'call',
    'gesprek',
    'afspraak',
    'appointment',
    'weekly',
    'daily',
    'sync',
    'standup',
    'the',
    'and',
    'van',
    'met',
    'voor'
  ])

  for (const word of normalise(event.title).split(/[^\p{L}\p{N}]+/u)) {
    if (word.length < 4 || STOP_WORDS.has(word)) continue
    out.push({ matcher: 'title', pattern: word })
  }

  // A location that is a place rather than a link says something durable about the work.
  const location = normalise(event.location ?? '')
  if (location.length >= 4 && !location.startsWith('http')) {
    out.push({ matcher: 'location', pattern: location })
  }

  return out
}
