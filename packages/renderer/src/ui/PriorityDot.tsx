import type { Priority } from '@core/contract/types.js'

const colors: Record<Priority, string> = {
  high: 'bg-prio-high',
  medium: 'bg-prio-med',
  low: 'bg-prio-low'
}

export const PRIORITY_LABEL: Record<Priority, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low'
}

/** The coloured dot that carries priority everywhere — never priority as text alone. */
export function PriorityDot({ priority, size = 8 }: { priority: Priority; size?: number }) {
  return (
    <span
      aria-label={PRIORITY_LABEL[priority]}
      className={`inline-block shrink-0 rounded-full ${colors[priority]}`}
      style={{ width: size, height: size }}
    />
  )
}
