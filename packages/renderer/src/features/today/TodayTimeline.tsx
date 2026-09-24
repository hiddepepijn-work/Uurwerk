import type { TimelineSegment } from '@core/contract/types.js'
import { formatDuration, formatSpan } from '../../lib/format.js'

/**
 * The day's tracked time, drawn to scale.
 *
 * The window is not fixed to office hours. It fits itself to the day you actually had,
 * rounded out to whole hours, with a minimum span so a single short session does not fill
 * the whole bar. Work at 06:00 or until 23:30 and it simply widens — a fixed 08:00–18:00
 * strip would have quietly cut those hours off the picture.
 *
 * A stretch divided after the fact is drawn as the one bar it was, split lengthwise into its
 * shares. Its slices carry clock times that were never real: the split of a four-hour
 * afternoon into 2h of A then 1h of B is a statement about how much, not about when. Drawing
 * them as three consecutive blocks would put an invented chronology on the screen.
 */

const MIN_SPAN_MIN = 4 * 60
const DAY_MIN = 24 * 60

/** Anything under a minute is a mis-click, not work worth a mark on the timeline. */
const MIN_VISIBLE_MIN = 1

const minuteOfDay = (ms: number): number => {
  const d = new Date(ms)
  return d.getHours() * 60 + d.getMinutes()
}

interface Window {
  start: number
  end: number
}

/**
 * One bar on the timeline: a stretch of clock time, and what it went to.
 *
 * A stretch tracked against a single task has one part. A stretch divided afterwards has one
 * part per share, and `estimated` says the parts' sizes are meant but their order is not.
 */
interface Bar {
  key: string
  startedAt: number
  endedAt: number
  durationMin: number
  estimated: boolean
  parts: Array<{ key: string; taskTitle: string | null; durationMin: number }>
}

/**
 * Folds the day's segments into bars, rejoining the slices of a divided stretch.
 *
 * Slices share an `attributionGroup`; anything else is its own bar. The bar's span comes from
 * the slices' outer edges, which is where the stretch really began and ended.
 */
function toBars(segments: TimelineSegment[]): Bar[] {
  const bars = new Map<string, Bar>()

  for (const segment of segments) {
    const key = segment.attributionGroup ?? segment.sessionId
    const existing = bars.get(key)

    if (!existing) {
      bars.set(key, {
        key,
        startedAt: segment.startedAt,
        endedAt: segment.endedAt,
        durationMin: segment.durationMin,
        estimated: segment.attribution === 'estimated',
        parts: [
          { key: segment.sessionId, taskTitle: segment.taskTitle, durationMin: segment.durationMin }
        ]
      })
      continue
    }

    existing.startedAt = Math.min(existing.startedAt, segment.startedAt)
    existing.endedAt = Math.max(existing.endedAt, segment.endedAt)
    existing.durationMin += segment.durationMin
    existing.parts.push({
      key: segment.sessionId,
      taskTitle: segment.taskTitle,
      durationMin: segment.durationMin
    })
  }

  return [...bars.values()]
    .map((bar) => ({ ...bar, parts: [...bar.parts].sort((a, b) => b.durationMin - a.durationMin) }))
    .sort((a, b) => a.startedAt - b.startedAt)
}

/** Fits the window to the tracked span, padded to whole hours. */
function fitWindow(bars: Bar[]): Window {
  if (bars.length === 0) return { start: 8 * 60, end: 18 * 60 }

  const first = Math.min(...bars.map((b) => minuteOfDay(b.startedAt)))
  const last = Math.max(...bars.map((b) => minuteOfDay(b.endedAt)))

  let start = Math.max(0, Math.floor(first / 60) * 60)
  let end = Math.min(DAY_MIN, Math.ceil(last / 60) * 60)

  // Grow a short day outward rather than stretching one session across the whole bar.
  while (end - start < MIN_SPAN_MIN) {
    if (end < DAY_MIN) end += 60
    else if (start > 0) start -= 60
    else break
  }

  return { start, end }
}

/** Roughly one label per 90px of width, on whole hours. */
function ticksFor(window: Window): number[] {
  const spanHours = (window.end - window.start) / 60
  const step = spanHours <= 6 ? 1 : spanHours <= 12 ? 2 : 3
  const ticks: number[] = []
  for (let hour = Math.ceil(window.start / 60); hour * 60 <= window.end; hour += step) {
    ticks.push(hour)
  }
  return ticks
}

const label = (taskTitle: string | null): string => taskTitle ?? 'Not assigned'

export function TodayTimeline({ segments }: { segments: TimelineSegment[] }) {
  const bars = toBars(segments).filter((bar) => bar.durationMin >= MIN_VISIBLE_MIN)
  const window = fitWindow(bars)
  const span = window.end - window.start
  const position = (minute: number): number => ((minute - window.start) / span) * 100

  const tracked = bars.reduce((total, bar) => total + bar.durationMin, 0)

  return (
    <div>
      <div className="mb-5 flex items-baseline justify-between">
        <h2 className="text-[15px] font-semibold">Today&apos;s timeline</h2>
        <span className="text-[13px] text-text-dim">
          {bars.length === 0
            ? 'Nothing tracked yet'
            : `${formatDuration(tracked)} across ${bars.length} ${bars.length === 1 ? 'session' : 'sessions'}`}
        </span>
      </div>

      <div className="relative mb-2 h-4 text-[11px] text-text-dim">
        {ticksFor(window).map((hour) => (
          <span
            key={hour}
            className="absolute -translate-x-1/2 tabular-nums"
            style={{ left: `${position(hour * 60)}%` }}
          >
            {String(hour).padStart(2, '0')}:00
          </span>
        ))}
      </div>

      <div className="relative h-10 w-full overflow-hidden rounded-[10px] border border-border bg-card">
        {bars.map((bar) => {
          const from = Math.max(minuteOfDay(bar.startedAt), window.start)
          const to = Math.min(minuteOfDay(bar.endedAt), window.end)
          if (to <= from) return null

          const total = bar.parts.reduce((sum, part) => sum + part.durationMin, 0) || 1

          return (
            <div
              key={bar.key}
              title={`${formatSpan(bar.startedAt, bar.endedAt)} · ${formatDuration(bar.durationMin)}\n${bar.parts
                .map(
                  (part) =>
                    `${label(part.taskTitle)} — ${formatDuration(part.durationMin)}${
                      bar.estimated ? ` (${Math.round((part.durationMin / total) * 100)}%)` : ''
                    }`
                )
                .join('\n')}`}
              className="absolute top-1.5 bottom-1.5 flex overflow-hidden rounded-[6px] transition-all"
              style={{
                left: `${position(from)}%`,
                // A two-minute session still needs to be hoverable.
                width: `max(3px, ${((to - from) / span) * 100}%)`
              }}
            >
              {bar.parts.map((part) => (
                <span
                  key={part.key}
                  // A share with no task is drawn faint rather than dropped: the time was
                  // worked, and hiding it would make the bar shorter than the day was.
                  className={`h-full ${part.taskTitle === null ? 'bg-accent/25' : 'bg-accent'}`}
                  style={{ width: `${(part.durationMin / total) * 100}%` }}
                />
              ))}
            </div>
          )
        })}

        {bars.length === 0 && (
          <span className="absolute inset-0 flex items-center justify-center text-[13px] text-text-faint">
            Press START to begin tracking
          </span>
        )}
      </div>

      {bars.length > 0 && (
        <div className="mt-5 grid grid-cols-2 gap-x-10 gap-y-4 lg:grid-cols-3 xl:grid-cols-4">
          {bars.map((bar) => (
            <div key={bar.key} className="min-w-0">
              <div className="font-mono text-[13px] text-accent tabular-nums">
                {formatSpan(bar.startedAt, bar.endedAt)}
                <span className="ml-2 text-text-dim">{formatDuration(bar.durationMin)}</span>
              </div>
              {/* A divided stretch lists its shares; a tracked one is simply its task. */}
              {bar.estimated ? (
                <ul className="mt-1 flex flex-col gap-0.5">
                  {bar.parts.map((part) => (
                    <li key={part.key} className="flex items-baseline gap-1.5 text-[13px]">
                      <span className="truncate text-text-dim">{label(part.taskTitle)}</span>
                      {/* The tilde is the whole point: a share, not a measurement. */}
                      <span className="shrink-0 font-mono text-text-faint tabular-nums">
                        ~{formatDuration(part.durationMin)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="mt-0.5 truncate text-[13px] text-text-dim">
                  {label(bar.parts[0]?.taskTitle ?? null)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
