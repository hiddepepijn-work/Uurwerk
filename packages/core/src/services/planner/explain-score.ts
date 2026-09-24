/**
 * Turns a score into sentences.
 *
 * Every scheduled block carries its reasoning, so the answer to "why is this here?" is
 * always one hover away. This is the difference between a planner you correct and a
 * planner you argue with — and the reason the scoring is a plain weighted sum rather than
 * anything that would have to be explained after the fact.
 */

import type { ScoredTask } from './priority-score.js'
import { formatDuration } from './format.js'

/** A single line: "Recommended score: 91". */
export const headline = (scored: ScoredTask): string => `Recommended score: ${scored.score}`

/** The bullet points, strongest reason first, with zero-point terms left out. */
export function reasons(scored: ScoredTask): string[] {
  const lines = scored.terms
    .filter((term) => term.points > 0)
    .sort((a, b) => b.points - a.points)
    .map((term) => term.detail)

  lines.push(
    scored.isDiscovery
      ? `No estimate yet — ${formatDuration(scored.scheduleMin)} to find out how long it takes`
      : `About ${formatDuration(scored.scheduleMin)} of work left`
  )

  return lines
}

/** The compact form stored on a plan block and shown in the grid. */
export function explain(scored: ScoredTask): string {
  return [headline(scored), ...reasons(scored).map((line) => `- ${line}`)].join('\n')
}

/**
 * Why a task did not make the plan, phrased as something you can act on rather than as a
 * refusal. An empty plan with no explanation is the worst thing a planner can produce.
 */
export function explainOmission(reason: string, taskTitle: string): string {
  switch (reason) {
    case 'no-room':
      return `${taskTitle} did not fit in the time left today.`
    case 'buffer':
      return `${taskTitle} was left out to keep some slack in the day.`
    default:
      return `${taskTitle} was not scheduled.`
  }
}
