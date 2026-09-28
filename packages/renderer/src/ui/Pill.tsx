import type { ReactNode } from 'react'

/** Small tag: project names, counts, statuses. Tinted fill, no border. */
export function Pill({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'accent' }) {
  const styles = tone === 'accent' ? 'bg-rail-active text-accent-soft' : 'bg-input text-text-dim'
  return (
    <span className={`inline-flex items-center gap-1 rounded-pill px-2.5 py-0.5 text-xs font-bold ${styles}`}>
      {children}
    </span>
  )
}
