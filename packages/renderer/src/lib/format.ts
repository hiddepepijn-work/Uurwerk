/**
 * English formatting for the UI.
 *
 * Deliberately separate from core/i18n/format.ts, which is Dutch and belongs to the
 * supervisor-facing report. The mockups are English ("4h 12m"), the report is Dutch
 * ("4u 12m"), and mixing the two would leak one into the other.
 */

/** "4h 12m" · "45m" · "0m" */
export function formatDuration(minutes: number): string {
  const safe = Math.max(0, Math.round(minutes))
  const h = Math.floor(safe / 60)
  const m = safe % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${String(m).padStart(2, '0')}m`
}

/** "01:24:36" — the big readout. */
export function formatStopwatch(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map((n) => String(n).padStart(2, '0'))
    .join(':')
}

/** "09:15" */
export const formatClock = (ms: number): string =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date(ms))

/** "09:15 – 10:45" */
export const formatSpan = (fromMs: number, toMs: number): string =>
  `${formatClock(fromMs)} – ${formatClock(toMs)}`

/** Minute-of-day (planning grid) to "09:00". */
export const formatMinuteOfDay = (minute: number): string =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`

/** "Thursday, 8 May 2025" */
export const formatLongDate = (input: Date | number): string =>
  new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }).format(typeof input === 'number' ? new Date(input) : input)

/** Local 'YYYY-MM-DD' — the app's date key, must match core/util/time.toIsoDate. */
export function toIsoDate(input: Date | number = new Date()): string {
  const d = typeof input === 'number' ? new Date(input) : input
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
