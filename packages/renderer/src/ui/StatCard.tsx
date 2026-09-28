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
    <div className="flex flex-col gap-2 rounded-card bg-card p-4">
      <div className="flex items-center gap-[7px]">
        <span className="text-accent-soft">{icon}</span>
        <span className="text-[13px] font-bold text-text-dim">{label}</span>
      </div>
      <div className="font-display text-[30px] leading-none font-bold tracking-[-0.6px] text-text tabular-nums">
        {value}
      </div>
      {sub && <div className="text-[13px] text-text-faint">{sub}</div>}
      {progress && <ProgressBar value={progress.value} max={progress.max} />}
    </div>
  )
}
