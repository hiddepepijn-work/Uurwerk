/**
 * The five-second rule, as a command: "Hey Jarvis, 5 sec".
 *
 * Count down five seconds, stand up, start — and then ten minutes of focus on a timer of its
 * own, apart from the timer that counts hours. Jarvis says nothing: the countdown is the
 * answer. So the phrase is recognised before the language model ever sees it.
 */

export const SPRINT_COUNTDOWN_MS = 5_000
export const SPRINT_FOCUS_MS = 10 * 60_000

export interface SprintState {
  phase: 'idle' | 'countdown' | 'focus'
  /** When the countdown began. */
  startedAt: number | null
  /** When the focus begins (after the countdown). */
  focusAt: number | null
  /** When the ten minutes are over. */
  endsAt: number | null
}

export const IDLE_SPRINT: SprintState = { phase: 'idle', startedAt: null, focusAt: null, endsAt: null }

export function sprintFrom(now: number): SprintState {
  return {
    phase: 'countdown',
    startedAt: now,
    focusAt: now + SPRINT_COUNTDOWN_MS,
    endsAt: now + SPRINT_COUNTDOWN_MS + SPRINT_FOCUS_MS
  }
}

/** The phase at `now`, for a sprint started earlier (a screen opening halfway through). */
export function sprintAt(state: SprintState, now: number): SprintState {
  if (state.phase === 'idle' || state.endsAt === null || state.focusAt === null) return IDLE_SPRINT
  if (now >= state.endsAt) return IDLE_SPRINT
  return { ...state, phase: now >= state.focusAt ? 'focus' : 'countdown' }
}

const normalise = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * "5 sec", "vijf seconden", "5 seconden modus", "five seconds", "hey jarvis 5 sec" — and only
 * when that is all, or nearly all, that was said: "ik ben over 5 seconden klaar met eten" is a
 * sentence for Jarvis, not a command.
 */
export function isSprintCommand(text: string): boolean {
  const words = normalise(text)
    .replace(/^(hey |he |hee |hi |oke |ok )?(jarvis )?/, '')
    .split(' ')
    .filter(Boolean)
  if (words.length === 0 || words.length > 4) return false
  const said = words.join(' ')
  return /^(de )?(5|vijf|five) ?(s|sec|secs|seconde|seconden|second|seconds)( modus| regel| rule| mode)?( graag| nu| please)?$/.test(said)
}
