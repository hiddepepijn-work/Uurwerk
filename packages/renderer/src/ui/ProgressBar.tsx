import { useEffect, useState } from 'react'

interface Props {
  value: number
  max: number
  className?: string
}

/**
 * Progress toward a goal. Green fill, grey track — the same meaning as everywhere else.
 * Overshoot is clamped visually but never hidden: the number above it still says 21h/40h.
 *
 * The fill grows from 0 on mount and follows later changes on the soft spring (1.1 s); the
 * track's overflow clips the spring's small overshoot past 100%.
 */
export function ProgressBar({ value, max, className = '' }: Props) {
  const fraction = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0
  const [grown, setGrown] = useState(false)
  useEffect(() => {
    // Two frames: the empty bar must be painted once before the width can transition.
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setGrown(true))
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
    }
  }, [])
  return (
    <div className={`h-1.5 w-full overflow-hidden rounded-[3px] bg-border ${className}`}>
      <div
        className="h-full rounded-[3px] bg-accent"
        style={{
          width: `${(grown ? fraction : 0) * 100}%`,
          transition: 'width 1.1s var(--spring-soft)'
        }}
      />
    </div>
  )
}
