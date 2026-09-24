import { useState } from 'react'
import type { AreaShare, Bucket } from '@core/contract/types.js'
import { formatDuration } from '../../lib/format.js'

/**
 * The chart pieces, drawn with plain elements.
 *
 * No chart library: the renderer's CSP forbids anything off-origin, the shapes here are
 * rectangles, and a dependency that draws rectangles is a dependency to audit forever.
 *
 * Three rules carried through all of them:
 *   - identity is never colour alone — every series is in the legend and labelled in the
 *     tooltip and the table, so a colourblind reader loses nothing
 *   - a 2px gap of surface sits between adjacent bars, which is what keeps two colours from
 *     reading as one wide block
 *   - values are text-coloured, never series-coloured; the swatch beside them carries the
 *     identity
 */

/** Not an area, and deliberately outside the categorical palette: context, not a category. */
export const SCREEN_TIME_COLOR = '#94A3B8'

export interface Series {
  id: string
  name: string
  color: string
}

// ------------------------------------------------------------ grouped bars

/**
 * Hours per bucket, one bar per selected series.
 *
 * Grouped rather than stacked on purpose: the question is "how did Stage compare with
 * School", and a stacked bar answers "how much in total" while making every segment except
 * the bottom one impossible to compare across columns.
 */
export function GroupedBars({
  buckets,
  series,
  maxMin
}: {
  buckets: Bucket[]
  series: Series[]
  /** Shared scale across every bucket; per-bucket scaling would make the chart a liar. */
  maxMin: number
}) {
  const [hover, setHover] = useState<{ bucket: string; series: string } | null>(null)
  const ceiling = Math.max(60, Math.ceil(maxMin / 60) * 60)
  const gridLines = [0, 0.25, 0.5, 0.75, 1]

  return (
    <div className="relative">
      <div className="flex gap-3">
        {/* y axis */}
        <div className="relative w-10 shrink-0" style={{ height: 220 }}>
          {gridLines.map((step) => (
            <span
              key={step}
              className="absolute right-0 -translate-y-1/2 font-mono text-[11px] text-text-faint tabular-nums"
              style={{ top: `${(1 - step) * 100}%` }}
            >
              {Math.round((ceiling * step) / 60)}h
            </span>
          ))}
        </div>

        <div className="relative min-w-0 flex-1" style={{ height: 220 }}>
          {gridLines.map((step) => (
            <div
              key={step}
              className="absolute right-0 left-0 border-t border-border/60"
              style={{ top: `${(1 - step) * 100}%` }}
            />
          ))}

          <div className="absolute inset-0 flex items-end justify-between gap-2">
            {buckets.map((bucket) => (
              <div key={bucket.key} className="flex h-full min-w-0 flex-1 items-end justify-center gap-[2px]">
                {series.map((entry) => {
                  const minutes =
                    entry.id === 'screen-time'
                      ? bucket.screenTimeMin
                      : (bucket.byArea[entry.id] ?? 0)
                  const height = ceiling === 0 ? 0 : (minutes / ceiling) * 100
                  const active = hover?.bucket === bucket.key && hover.series === entry.id

                  return (
                    <button
                      key={entry.id}
                      onMouseEnter={() => setHover({ bucket: bucket.key, series: entry.id })}
                      onMouseLeave={() => setHover(null)}
                      onFocus={() => setHover({ bucket: bucket.key, series: entry.id })}
                      onBlur={() => setHover(null)}
                      aria-label={`${bucket.label}, ${entry.name}: ${formatDuration(minutes)}`}
                      className="group relative flex h-full w-full max-w-[26px] cursor-default items-end"
                    >
                      <span
                        className="w-full rounded-t-[4px] transition-[filter]"
                        style={{
                          height: `${Math.max(minutes > 0 ? 2 : 0, height)}%`,
                          background: entry.color,
                          // Screen time is context, so it sits behind the areas visually.
                          opacity: entry.id === 'screen-time' ? 0.45 : 1,
                          filter: active ? 'brightness(1.25)' : undefined
                        }}
                      />

                      {active && minutes > 0 && (
                        <span className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 -translate-x-1/2 rounded-[8px] border border-border-strong bg-card px-2.5 py-1.5 whitespace-nowrap shadow-lg">
                          <span className="flex items-center gap-1.5 text-[12px] text-text">
                            <span
                              className="h-2 w-2 shrink-0 rounded-full"
                              style={{ background: entry.color }}
                            />
                            {entry.name}
                          </span>
                          <span className="block font-mono text-[12px] text-text-dim tabular-nums">
                            {formatDuration(minutes)}
                          </span>
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-2 flex gap-3 pl-[52px]">
        {buckets.map((bucket) => (
          <div key={bucket.key} className="min-w-0 flex-1 text-center">
            <div className="truncate text-[12px] text-text-dim">{bucket.label}</div>
            <div className="truncate text-[11px] text-text-faint">{bucket.sublabel}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ------------------------------------------------------------- share bars

/** Minutes per area as a proportion of tracked time, biggest first. */
export function ShareBars({ areas }: { areas: AreaShare[] }) {
  if (areas.length === 0) {
    return <p className="text-[13px] text-text-faint">Nothing tracked in this period.</p>
  }

  return (
    <ul className="flex flex-col gap-3.5">
      {areas.map((area) => (
        <li key={area.areaId} className="flex items-center gap-3">
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ background: area.color }}
          />
          <span className="w-24 shrink-0 truncate text-[13px] text-text">{area.name}</span>

          <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-bg">
            <span
              className="block h-full rounded-full"
              style={{ width: `${Math.max(2, area.fraction * 100)}%`, background: area.color }}
            />
          </span>

          <span className="w-20 shrink-0 text-right font-mono text-[13px] text-text-dim tabular-nums">
            {formatDuration(area.minutes)}
          </span>
          <span className="w-10 shrink-0 text-right font-mono text-[13px] text-text-faint tabular-nums">
            {Math.round(area.fraction * 100)}%
          </span>
        </li>
      ))}
    </ul>
  )
}

// ------------------------------------------------------------- table view

/**
 * The same numbers as text.
 *
 * Required rather than decorative: it is what makes the chart usable with a screen reader,
 * in forced-colours mode, and when a printed copy has lost every hue.
 */
export function BucketTable({ buckets, series }: { buckets: Bucket[]; series: Series[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead className="text-text-dim">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Period</th>
            {series.map((entry) => (
              <th key={entry.id} className="px-3 py-2 text-right font-medium">
                {entry.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {buckets.map((bucket) => (
            <tr key={bucket.key} className="border-t border-border">
              <td className="px-3 py-2 text-text">
                {bucket.label}
                <span className="ml-2 text-text-faint">{bucket.sublabel}</span>
              </td>
              {series.map((entry) => {
                const minutes =
                  entry.id === 'screen-time' ? bucket.screenTimeMin : (bucket.byArea[entry.id] ?? 0)
                return (
                  <td
                    key={entry.id}
                    className="px-3 py-2 text-right font-mono text-text-dim tabular-nums"
                  >
                    {minutes === 0 ? '—' : formatDuration(minutes)}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
