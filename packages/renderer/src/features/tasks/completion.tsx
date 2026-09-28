import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Task } from '@core/contract/types.js'
import { play, prefersReducedMotion } from '../agenda/motion.js'

/**
 * Ticking a task off, as a small moment rather than a repaint: the circle fills, the check
 * draws itself, a few sparks fly off in the task's area colour, the title is struck through
 * and then the row slides out and closes up. Shared by the queue (TaskRow) and the
 * priority view.
 *
 * The save waits for the moment to play — the list drops a done task as soon as it is
 * saved, which would cut it off. Leaving the screen mid-way still saves it. Reopening a
 * done task, or reduced motion, saves at once.
 */

/** From the spec: check 350 ms, sparks 700 ms, the row goes after 900 ms. */
const AWAY_AT = 900
const SAVE_AT = 1350
/** If the save never shows up (it failed), the row comes back rather than staying shut. */
const GIVE_UP_AT = SAVE_AT + 2000

export type CompletionPhase = 'idle' | 'checked' | 'leaving'

export function useCompletion<T extends HTMLElement>(task: Task, onToggleComplete: (task: Task) => void) {
  const [phase, setPhase] = useState<CompletionPhase>('idle')
  const row = useRef<T | null>(null)
  const timers = useRef<number[]>([])
  const pending = useRef<(() => void) | null>(null)
  const save = useRef(onToggleComplete)
  save.current = onToggleComplete

  const reset = (): void => {
    timers.current.forEach((id) => window.clearTimeout(id))
    timers.current = []
    row.current?.getAnimations?.().forEach((animation) => animation.cancel())
    if (row.current) row.current.style.overflow = ''
    setPhase('idle')
  }

  // Gone before the save: it still happens.
  useEffect(
    () => () => {
      timers.current.forEach((id) => window.clearTimeout(id))
      pending.current?.()
    },
    []
  )

  // Still here once saved (a list that shows done tasks): open up again, in its done look.
  useEffect(() => {
    if (task.status === 'done' && phase !== 'idle' && !pending.current) reset()
  }, [task.status]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (): void => {
    if (phase !== 'idle') return
    if (task.status === 'done' || prefersReducedMotion()) return save.current(task)
    setPhase('checked')
    const commit = (): void => {
      pending.current = null
      save.current(task)
    }
    pending.current = commit
    timers.current = [
      window.setTimeout(() => {
        setPhase('leaving')
        slideAway(row.current)
      }, AWAY_AT),
      window.setTimeout(commit, SAVE_AT),
      window.setTimeout(reset, GIVE_UP_AT)
    ]
  }

  return { phase, row, toggle, checked: phase !== 'idle' }
}

/** Out to the right while fading, then the gap it leaves closes. */
function slideAway(element: HTMLElement | null): void {
  if (!element) return
  const style = getComputedStyle(element)
  play(element, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(40px) scale(0.96)' }], {
    duration: 450,
    easing: '--spring-soft',
    fill: 'forwards'
  })
  element.style.overflow = 'hidden'
  play(
    element,
    [
      {
        height: `${element.getBoundingClientRect().height}px`,
        paddingTop: style.paddingTop,
        paddingBottom: style.paddingBottom,
        borderTopWidth: style.borderTopWidth
      },
      { height: '0px', paddingTop: '0px', paddingBottom: '0px', borderTopWidth: '0px' }
    ],
    { duration: 400, delay: 150, easing: '--ease-out', fill: 'forwards' }
  )
}

/**
 * The check inside a completion circle. Always in the DOM, so checking it draws the stroke
 * (a CSS transition on its dash) instead of popping a finished icon in.
 */
export function DrawnCheck({ drawn, size = 11 }: { drawn: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ opacity: drawn ? 1 : 0 }}
    >
      <path
        d="M20 6 9 17l-5-5"
        pathLength={1}
        style={{
          strokeDasharray: 1,
          strokeDashoffset: drawn ? 0 : 1,
          transition: drawn ? 'stroke-dashoffset 350ms var(--ease-out) 50ms' : 'none'
        }}
      />
    </svg>
  )
}

/** Eight sparks flying out from the centre of the circle they are placed in. */
export function Sparks({ color }: { color: string }) {
  const host = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    Array.from(host.current?.children ?? []).forEach((dot, index) => {
      const angle = (index / 8) * Math.PI * 2
      play(
        dot,
        [
          { opacity: 1, transform: 'translate(0, 0) scale(1)' },
          { opacity: 0, transform: `translate(${Math.cos(angle) * 26}px, ${Math.sin(angle) * 26}px) scale(0.3)` }
        ],
        { duration: 700, easing: '--ease-out', fill: 'forwards' }
      )
    })
  }, [])
  return (
    <span ref={host} aria-hidden className="pointer-events-none absolute top-1/2 left-1/2 z-10">
      {Array.from({ length: 8 }, (_, index) => (
        // Invisible at rest, so without an animation (reduced motion) nothing is left behind.
        <span key={index} className="absolute -top-[3px] -left-[3px] h-1.5 w-1.5 rounded-full opacity-0" style={{ background: color }} />
      ))}
    </span>
  )
}

/**
 * The title's strike, drawn left to right (paint only: a background line that grows). On
 * every line of a wrapped title at once.
 */
export const strikeStyle = (struck: boolean): React.CSSProperties => ({
  backgroundImage: 'linear-gradient(currentColor, currentColor)',
  backgroundRepeat: 'no-repeat',
  backgroundPosition: '0 55%',
  backgroundSize: struck ? '100% 2px' : '0% 2px',
  transition: 'background-size 350ms var(--ease-out) 150ms, color 250ms',
  WebkitBoxDecorationBreak: 'clone',
  boxDecorationBreak: 'clone'
})
