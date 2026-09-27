import type { Effort } from './providers.js'

/** Asks that rearrange the agenda: these get the higher thinking level. */
const REPLAN =
  /(in ?plannen|inplan|herplan|opnieuw (in)?plannen|plan (het|alles|opnieuw|de week|mijn week|in)|verzet|verschuif|schuif|reorganiseer|hele week|haal .* weg)/i

/** Low for everyday questions; replanning thinks harder. */
export function effortFor(text: string | undefined, everyday: Effort, replan: Effort): Effort {
  return text && REPLAN.test(text) ? replan : everyday
}
