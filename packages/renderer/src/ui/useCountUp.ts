import { useEffect, useRef, useState } from 'react'

/**
 * Count-up for the big numbers on stat tiles.
 *
 * Durations ("4h 35m", "18h", "35m") count in two phases: first the hours, then the minutes,
 * never both at once, so the eye can follow them. Plain numbers ("82%", "3 / 5") count once.
 * Anything without a number ("—") is shown as is. The display string is parsed generically;
 * text around the counted number stays put.
 */

/** Length of each duration phase (hours, then minutes). */
export const PHASE_MS = 500
/** Length of a plain-number count. */
export const NUMBER_MS = 800

export type Countable =
  | { kind: 'duration'; prefix: string; suffix: string; hours: number | null; minutes: number | null; pad: boolean }
  | { kind: 'number'; prefix: string; suffix: string; value: number; decimals: number; sep: string }
  | { kind: 'text'; text: string }

const DURATION = /(\d+)h(?:\s+(\d+)m)?|(\d+)m\b/
const NUMBER = /\d+(?:[.,]\d+)?/

/** Splits a display string into what counts and what stays put. */
export function parseCountable(text: string): Countable {
  const d = DURATION.exec(text)
  if (d) {
    const prefix = text.slice(0, d.index)
    const suffix = text.slice(d.index + d[0].length)
    if (d[3] !== undefined) {
      return { kind: 'duration', prefix, suffix, hours: null, minutes: Number(d[3]), pad: false }
    }
    const minutes = d[2] === undefined ? null : Number(d[2])
    return { kind: 'duration', prefix, suffix, hours: Number(d[1]), minutes, pad: d[2] !== undefined && d[2].length > 1 && d[2].startsWith('0') }
  }
  const n = NUMBER.exec(text)
  // Only a bare number counts: "82%", "3 / 5". A date ("12 Oct") or a label is text.
  if (n && !/\p{L}/u.test(text.slice(0, n.index) + text.slice(n.index + n[0].length))) {
    const sep = n[0].includes(',') ? ',' : '.'
    const decimals = n[0].includes(sep) ? n[0].split(sep)[1]!.length : 0
    return {
      kind: 'number',
      prefix: text.slice(0, n.index),
      suffix: text.slice(n.index + n[0].length),
      value: Number(n[0].replace(',', '.')),
      decimals,
      sep
    }
  }
  return { kind: 'text', text }
}

/** Total length of the animation from `from` to `to`; 0 means show `to` at once. */
export function countDuration(to: Countable, from: Countable | null): number {
  if (to.kind === 'text') return 0
  if (to.kind === 'number') {
    const start = from?.kind === 'number' ? from.value : 0
    return start === to.value ? 0 : NUMBER_MS
  }
  const { hours, minutes } = startOf(from)
  const hourPhase = to.hours !== null && hours !== to.hours
  const minutePhase = (to.minutes ?? 0) !== minutes || (hourPhase && to.minutes !== null)
  return (hourPhase ? PHASE_MS : 0) + (minutePhase ? PHASE_MS : 0)
}

const easeOut = (p: number): number => 1 - Math.pow(1 - p, 3)
const clamp01 = (p: number): number => Math.min(1, Math.max(0, p))

/** Where a duration count starts: the previous value when it was a duration too, else zero. */
function startOf(from: Countable | null): { hours: number; minutes: number } {
  if (from?.kind === 'duration') return { hours: from.hours ?? 0, minutes: from.minutes ?? 0 }
  return { hours: 0, minutes: 0 }
}

/**
 * The string to show `elapsed` ms into a count from `from` (null: from zero) to `to`.
 * Pure, so the phases are testable without a clock.
 */
export function frameAt(to: Countable, from: Countable | null, elapsed: number): string {
  if (to.kind === 'text') return to.text
  if (to.kind === 'number') {
    const start = from?.kind === 'number' ? from.value : 0
    const p = easeOut(clamp01(elapsed / NUMBER_MS))
    const v = start + (to.value - start) * p
    const shown = to.decimals > 0 ? v.toFixed(to.decimals).replace('.', to.sep) : String(Math.round(v))
    return `${to.prefix}${shown}${to.suffix}`
  }

  const start = startOf(from)
  const hourPhase = to.hours !== null && start.hours !== to.hours
  const pad = (m: number): string => (to.pad ? String(m).padStart(2, '0') : String(m))
  const wrap = (core: string): string => `${to.prefix}${core}${to.suffix}`

  // Minutes-only value ("35m"): one phase.
  if (to.hours === null) {
    const p = easeOut(clamp01(elapsed / PHASE_MS))
    return wrap(`${Math.round(start.minutes + ((to.minutes ?? 0) - start.minutes) * p)}m`)
  }

  let rest = elapsed
  if (hourPhase) {
    if (rest < PHASE_MS) {
      // Phase 1: hours only; the minutes are not shown yet.
      const h = Math.round(start.hours + (to.hours - start.hours) * easeOut(clamp01(rest / PHASE_MS)))
      return wrap(`${h}h`)
    }
    rest -= PHASE_MS
  }
  if (to.minutes === null) return wrap(`${to.hours}h`)
  // Phase 2: hours settled, minutes count from zero (or from where they were).
  const m0 = hourPhase ? 0 : start.minutes
  const m = Math.round(m0 + (to.minutes - m0) * easeOut(clamp01(rest / PHASE_MS)))
  return wrap(`${to.hours}h ${pad(m)}m`)
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

/** The display string for `value`, counting up on mount and whenever it changes. */
export function useCountUp(value: string): string {
  const [shown, setShown] = useState(() =>
    prefersReducedMotion() ? value : frameAt(parseCountable(value), null, 0)
  )
  const previous = useRef<Countable | null>(null)

  useEffect(() => {
    const to = parseCountable(value)
    // `previous` only moves once a count has landed, so a cancelled run (StrictMode's double
    // effect, or a value that changes mid-count) starts again from the last settled value.
    const from = previous.current
    const total = countDuration(to, from)
    if (total === 0 || prefersReducedMotion()) {
      previous.current = to
      setShown(frameAt(to, from, Number.POSITIVE_INFINITY))
      return
    }
    let raf = 0
    const t0 = performance.now()
    const step = (now: number): void => {
      const elapsed = now - t0
      setShown(frameAt(to, from, elapsed))
      if (elapsed < total) raf = requestAnimationFrame(step)
      else previous.current = to
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [value])

  return shown
}
