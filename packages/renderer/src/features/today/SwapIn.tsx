import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { play, prefersReducedMotion } from '../agenda/motion.js'

/**
 * Content that changes what it is about slides: the old version out to the left, the new
 * one in from the right. For the task on the timer when you switch — the change of subject
 * is the event, so it should be seen, not just repainted.
 *
 * `swapKey` names what is shown. A change to or from null (nothing running) is not a swap
 * and simply repaints; so does any change while motion is reduced.
 */
export function SwapIn({ swapKey, children }: { swapKey: string | null; children: ReactNode }) {
  const last = useRef<{ key: string | null; node: ReactNode }>({ key: swapKey, node: children })
  const [leaving, setLeaving] = useState<{ id: number; node: ReactNode } | null>(null)
  const entering = useRef<HTMLDivElement>(null)
  const exiting = useRef<HTMLDivElement>(null)

  // Every render: remember what was shown, and start a swap when its key changed.
  useLayoutEffect(() => {
    const previous = last.current
    last.current = { key: swapKey, node: children }
    if (previous.key === swapKey || previous.key === null || swapKey === null || prefersReducedMotion()) return
    play(entering.current, [{ opacity: 0, transform: 'translateX(28px)' }, { opacity: 1, transform: 'none' }], {
      duration: 550,
      delay: 80,
      fill: 'backwards',
      easing: '--spring-soft'
    })
    setLeaving({ id: performance.now(), node: previous.node })
  })

  useLayoutEffect(() => {
    if (!leaving) return
    const animation = play(exiting.current, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(-28px)' }], {
      duration: 300,
      fill: 'forwards',
      easing: '--ease-out'
    })
    if (!animation) return setLeaving(null)
    animation.onfinish = () => setLeaving((current) => (current?.id === leaving.id ? null : current))
    return () => {
      animation.onfinish = null
    }
  }, [leaving])

  return (
    <div className="relative">
      {leaving && (
        <div key={leaving.id} ref={exiting} aria-hidden className="pointer-events-none absolute inset-x-0 top-0">
          {leaving.node}
        </div>
      )}
      <div ref={entering}>{children}</div>
    </div>
  )
}
