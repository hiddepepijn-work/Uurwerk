import type { ReactNode } from 'react'

/**
 * Empty states say what to do next, never just "no data". An empty app on day one should
 * still tell you how to start.
 */
export function EmptyState({
  icon,
  title,
  hint,
  action
}: {
  icon?: ReactNode
  title: string
  hint?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      {icon && <div className="mb-1 text-text-faint">{icon}</div>}
      <p className="text-sm text-text-dim">{title}</p>
      {hint && <p className="max-w-xs text-[13px] text-text-faint">{hint}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}
