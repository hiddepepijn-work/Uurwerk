import type { Area } from '@core/contract/types.js'
import { colorFor } from '../agenda/agenda-model.js'

/**
 * The area as a tinted pill: area tint behind, the area's soft colour as text. Answers the
 * question the task list otherwise hides — which bucket does this time land in?
 */
export function AreaChip({ area, onFill = false }: { area: Area | null; onFill?: boolean }) {
  if (!area) return null
  const color = colorFor(area.id)
  return (
    <span
      className={`shrink-0 rounded-pill px-[9px] py-0.5 text-[12px] font-bold ${onFill ? 'bg-black/15' : ''}`}
      style={onFill ? undefined : { background: color.tint, color: color.soft }}
    >
      {area.name}
    </span>
  )
}
