interface Props {
  value: number
  max: number
  className?: string
}

/**
 * Progress toward a goal. Green fill, grey track — the same meaning as everywhere else.
 * Overshoot is clamped visually but never hidden: the number above it still says 21h/40h.
 */
export function ProgressBar({ value, max, className = '' }: Props) {
  const fraction = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0
  return (
    <div className={`h-1.5 w-full overflow-hidden rounded-full bg-border ${className}`}>
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-500"
        style={{ width: `${fraction * 100}%` }}
      />
    </div>
  )
}
