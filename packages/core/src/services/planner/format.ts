/**
 * Duration wording for planner explanations.
 *
 * Separate from core/i18n/format.ts on purpose: that one is Dutch and belongs to the
 * supervisor report, while these strings appear in the English UI. Sharing them would
 * leak one language into the other the first time either changed.
 */
export function formatDuration(minutes: number): string {
  const safe = Math.max(0, Math.round(minutes))
  const hours = Math.floor(safe / 60)
  const rest = safe % 60
  if (hours === 0) return `${rest}m`
  if (rest === 0) return `${hours}h`
  return `${hours}h ${String(rest).padStart(2, '0')}m`
}

/** "09:00" from minutes since midnight. */
export const formatClock = (minute: number): string =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
