import type { ReactNode } from 'react'
import { ProgressBar } from './ProgressBar.js'

interface Props {
  icon: ReactNode
  label: string
  value: string
  sub?: string
  progress?: { value: number; max: number }
}

/** The stat tile reused on Today, Week and in the end-of-day wizard. */
export function StatCard({ icon, label, value, sub, progress }: Props) {
  return (
    <div className="rounded-[12px] border border-border bg-card p-5">
      <div className="mb-3 flex items-center gap-2 text-text-dim">
        <span className="text-accent">{icon}</span>
        <span className="text-[13px]">{label}</span>
      </div>
      <div className="font-mono text-[28px] leading-none font-semibold text-text">{value}</div>
      {sub && <div className="mt-2 text-[13px] text-text-dim">{sub}</div>}
      {progress && <ProgressBar className="mt-3" value={progress.value} max={progress.max} />}
    </div>
  )
}
