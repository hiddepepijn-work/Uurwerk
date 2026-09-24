import type { ReactNode } from 'react'

/** Small grey tag: project names, counts, statuses. */
export function Pill({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'accent' }) {
  const styles =
    tone === 'accent'
      ? 'border-accent/30 bg-accent/10 text-accent'
      : 'border-border bg-bg text-text-dim'
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${styles}`}>
      {children}
    </span>
  )
}
