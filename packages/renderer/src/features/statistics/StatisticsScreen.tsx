import { useMemo, useState } from 'react'
import type { BreakdownFilter, RangePreset, StatisticsOverview } from '@core/contract/types.js'
import { useLiveQuery } from '../../hooks/useLiveQuery.js'
import { Card } from '../../ui/Card.js'
import { formatDuration } from '../../lib/format.js'
import {
  BarChartIcon,
  CalendarIcon,
  CheckIcon,
  ClockIcon,
  ShieldIcon,
  TrendingUpIcon
} from '../../ui/icons.js'
import { BucketTable, GroupedBars, ShareBars, SCREEN_TIME_COLOR, type Series } from './charts.js'

const RANGES: Array<{ id: RangePreset; label: string }> = [
  { id: 'week', label: 'This week' },
  { id: '4weeks', label: '4 weeks' },
  { id: '3months', label: '3 months' }
]

/**
 * Where the week actually went.
 *
 * The other screens answer "what now" — this one answers "what happened", which is a
 * different job and the reason it earns its own place in the rail rather than another tab
 * inside Week.
 *
 * Everything is one query for one range, so no two panels can disagree about which days
 * they are describing, and every panel obeys the filters above it.
 */
export function StatisticsScreen() {
  const [preset, setPreset] = useState<RangePreset>('4weeks')
  const [areaId, setAreaId] = useState('')
  const [organizationId, setOrganizationId] = useState('')
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [showTable, setShowTable] = useState(false)

  const { data: areas } = useLiveQuery((client) => client.areas.list(), ['settings'], [])
  const { data: organizations } = useLiveQuery(
    (client) => client.organizations.list(),
    ['settings'],
    []
  )

  const filter: BreakdownFilter = useMemo(
    () => ({
      ...(areaId ? { areaIds: [areaId] } : {}),
      ...(organizationId ? { organizationIds: [organizationId] } : {})
    }),
    [areaId, organizationId]
  )

  const { data } = useLiveQuery<StatisticsOverview>(
    (client) => client.statistics.overview({ preset }, filter),
    ['sessions', 'tasks', 'planning', 'settings'],
    [preset, areaId, organizationId]
  )

  /**
   * One series per area that has time, in a fixed order.
   *
   * Colour follows the area, never its rank, so filtering to two areas does not repaint the
   * survivors — the green bar is Stage whichever other bars are on screen.
   */
  const series: Series[] = useMemo(() => {
    const fromAreas = (areas ?? [])
      .filter((area) => (data?.areas ?? []).some((share) => share.areaId === area.id))
      .map((area) => ({ id: area.id, name: area.name, color: area.color }))

    return [
      ...fromAreas,
      { id: 'screen-time', name: 'Screen time', color: SCREEN_TIME_COLOR }
    ]
  }, [areas, data?.areas])

  const visible = series.filter((entry) => !hidden.has(entry.id))

  if (!data) return null

  const maxMin = Math.max(
    1,
    ...data.buckets.flatMap((bucket) =>
      visible.map((entry) =>
        entry.id === 'screen-time' ? bucket.screenTimeMin : (bucket.byArea[entry.id] ?? 0)
      )
    )
  )

  const select =
    'rounded-[10px] border border-border bg-card px-3 py-2 text-[13px] text-text outline-none focus:border-accent'

  return (
    <div className="p-8">
      <header className="mb-7 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-[32px] leading-tight font-semibold">Statistics</h1>
          <p className="mt-1 text-[14px] text-text-dim">
            {data.from} – {data.to}
          </p>
        </div>

        {/* Filters in one row above the charts, so what you changed is next to what changed. */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex rounded-[10px] border border-border bg-card p-1">
            {RANGES.map((range) => (
              <button
                key={range.id}
                onClick={() => setPreset(range.id)}
                className={`rounded-[7px] px-3.5 py-1.5 text-[13px] transition-colors ${
                  preset === range.id
                    ? 'bg-rail-active text-accent'
                    : 'text-text-dim hover:text-text'
                }`}
              >
                {range.label}
              </button>
            ))}
          </div>

          {/* Area and organization are independent filters, deliberately: the same employer
              hosts internship work and work that is not. */}
          <select value={areaId} onChange={(e) => setAreaId(e.target.value)} className={select}>
            <option value="">Area: all</option>
            {(areas ?? []).map((area) => (
              <option key={area.id} value={area.id}>
                {area.name}
              </option>
            ))}
          </select>

          <select
            value={organizationId}
            onChange={(e) => setOrganizationId(e.target.value)}
            className={select}
          >
            <option value="">Organization: all</option>
            {(organizations ?? []).map((organization) => (
              <option key={organization.id} value={organization.id}>
                {organization.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      <div className="mb-6 grid grid-cols-3 gap-4 xl:grid-cols-6">
        <Tile icon={<ClockIcon size={16} />} label="Tracked" metric={data.tracked} />
        <Tile icon={<BarChartIcon size={16} />} label="Stage hours" metric={data.stage} />
        <Tile icon={<CalendarIcon size={16} />} label="Planned" metric={data.planned} />
        <PercentTile
          icon={<TrendingUpIcon size={16} />}
          label="Plan completion"
          value={data.planCompletion}
          previous={data.previousPlanCompletion}
        />
        <CountTile icon={<CheckIcon size={16} />} label="Tasks completed" metric={data.tasksCompleted} />
        <Tile
          icon={<TrendingUpIcon size={16} />}
          label="Screen time"
          metric={data.screenTime}
          // Zero here means "never measured", which is not the same as "the laptop was off".
          empty={!data.hasScreenTime ? 'Measured from now on' : undefined}
        />
      </div>

      <div className="mb-6 grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-6">
        <Card
          title={data.daily ? 'Hours by day' : 'Hours by week'}
          action={
            <button
              onClick={() => setShowTable((value) => !value)}
              className="text-[12px] text-text-dim transition-colors hover:text-text"
            >
              {showTable ? 'Show chart' : 'Show table'}
            </button>
          }
        >
          <div className="mb-4 flex flex-wrap gap-2">
            {series.map((entry) => {
              const on = !hidden.has(entry.id)
              return (
                <button
                  key={entry.id}
                  onClick={() =>
                    setHidden((current) => {
                      const next = new Set(current)
                      if (on) next.add(entry.id)
                      else next.delete(entry.id)
                      return next
                    })
                  }
                  className={`flex items-center gap-2 rounded-full border px-3 py-1 text-[12px] transition-colors ${
                    on ? 'border-border-strong text-text' : 'border-border text-text-faint'
                  }`}
                >
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ background: entry.color, opacity: on ? 1 : 0.3 }}
                  />
                  {entry.name}
                </button>
              )
            })}
          </div>

          {showTable ? (
            <BucketTable buckets={data.buckets} series={visible} />
          ) : (
            <GroupedBars buckets={data.buckets} series={visible} maxMin={maxMin} />
          )}

          <p className="mt-3 text-[12px] text-text-faint">
            {data.daily
              ? 'This week, day by day. Screen time is how long the laptop was awake — context for the tracked hours, not part of them.'
              : 'One column per week. Screen time is how long the laptop was awake, not time you logged.'}
          </p>
        </Card>

        <div className="flex flex-col gap-6">
          <Card title="Time by area">
            <ShareBars areas={data.areas} />
          </Card>

          <Card title="Data quality">
            <div className="flex items-center gap-5">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full border-2 border-accent/40 text-[18px] font-semibold text-accent">
                {Math.round(data.quality.score * 100)}%
              </div>
              <ul className="flex min-w-0 flex-1 flex-col gap-1.5 text-[13px]">
                <QualityRow
                  ok={data.quality.segmentsWithoutTask === 0}
                  text={`${data.quality.segmentsWithoutTask} session${data.quality.segmentsWithoutTask === 1 ? '' : 's'} without a task`}
                />
                <QualityRow
                  ok={data.quality.tasksWithoutEstimate === 0}
                  text={`${data.quality.tasksWithoutEstimate} open task${data.quality.tasksWithoutEstimate === 1 ? '' : 's'} without an estimate`}
                />
                <QualityRow
                  ok={data.quality.openTrackingRuns === 0}
                  text={`${data.quality.openTrackingRuns} unfinished tracking run${data.quality.openTrackingRuns === 1 ? '' : 's'}`}
                />
                <QualityRow
                  ok={data.quality.categorisedFraction >= 0.9}
                  text={`${Math.round(data.quality.categorisedFraction * 100)}% of tracked time fully categorised`}
                />
              </ul>
            </div>
          </Card>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-6">
        <Card title="Projects">
          {data.projects.length === 0 ? (
            <p className="text-[13px] text-text-faint">Nothing tracked in this period.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {data.projects.slice(0, 6).map((project) => {
                const widest = data.projects[0]?.minutes ?? 1
                return (
                  <li key={project.projectId ?? 'none'} className="flex items-center gap-3">
                    <span
                      className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                        project.countsAsStageHours ? 'bg-accent' : 'bg-text-faint'
                      }`}
                      title={
                        project.countsAsStageHours
                          ? 'Counts toward internship hours'
                          : 'Does not count toward internship hours'
                      }
                    />
                    <span className="w-40 shrink-0 truncate text-[13px] text-text">
                      {project.name}
                    </span>
                    <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-bg">
                      <span
                        className={`block h-full rounded-full ${
                          project.countsAsStageHours ? 'bg-accent' : 'bg-text-faint'
                        }`}
                        style={{ width: `${Math.max(2, (project.minutes / widest) * 100)}%` }}
                      />
                    </span>
                    <span className="w-20 shrink-0 text-right font-mono text-[13px] text-text-dim tabular-nums">
                      {formatDuration(project.minutes)}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>

        <Card title="Planning insights">
          {data.workTypes.length === 0 ? (
            <p className="text-[13px] text-text-faint">
              Nothing planned or tracked with a work type yet.
            </p>
          ) : (
            <table className="w-full text-[13px]">
              <thead className="text-text-dim">
                <tr>
                  <th className="py-1.5 text-left font-medium">Work type</th>
                  <th className="py-1.5 text-right font-medium">Planned</th>
                  <th className="py-1.5 text-right font-medium">Actual</th>
                  <th className="py-1.5 text-right font-medium">Difference</th>
                </tr>
              </thead>
              <tbody>
                {data.workTypes.slice(0, 6).map((row) => {
                  const delta = row.actualMin - row.plannedMin
                  return (
                    <tr key={row.workTypeId ?? 'none'} className="border-t border-border">
                      <td className="py-2 text-text">{row.name}</td>
                      <td className="py-2 text-right font-mono text-text-dim tabular-nums">
                        {formatDuration(row.plannedMin)}
                      </td>
                      <td className="py-2 text-right font-mono text-text-dim tabular-nums">
                        {formatDuration(row.actualMin)}
                      </td>
                      <td
                        className={`py-2 text-right font-mono tabular-nums ${
                          row.plannedMin === 0
                            ? 'text-text-faint'
                            : delta > 0
                              ? 'text-prio-med'
                              : 'text-text-dim'
                        }`}
                      >
                        {row.plannedMin === 0
                          ? 'unplanned'
                          : `${delta >= 0 ? '+' : '−'}${formatDuration(Math.abs(delta))}`}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      {data.insights.length > 0 && (
        <div className="mt-6 flex flex-wrap items-center gap-6 rounded-[12px] border border-border bg-card px-5 py-4">
          <span className="text-[13px] font-medium text-text">Worth knowing</span>
          {data.insights.map((insight) => (
            <span key={insight.kind} className="flex items-center gap-2 text-[13px] text-text-dim">
              <span className="text-text-faint">
                <ShieldIcon size={14} />
              </span>
              {insight.text}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// -------------------------------------------------------------------- tiles

function Tile({
  icon,
  label,
  metric,
  empty
}: {
  icon: React.ReactNode
  label: string
  metric: { min: number; previousMin: number }
  empty?: string
}) {
  return (
    <Shell icon={icon} label={label} value={formatDuration(metric.min)}>
      {empty ?? <Delta value={metric.min - metric.previousMin} format={formatDuration} />}
    </Shell>
  )
}

function CountTile({
  icon,
  label,
  metric
}: {
  icon: React.ReactNode
  label: string
  metric: { min: number; previousMin: number }
}) {
  return (
    <Shell icon={icon} label={label} value={String(metric.min)}>
      <Delta value={metric.min - metric.previousMin} format={(n) => String(n)} />
    </Shell>
  )
}

function PercentTile({
  icon,
  label,
  value,
  previous
}: {
  icon: React.ReactNode
  label: string
  value: number | null
  previous: number | null
}) {
  return (
    <Shell
      icon={icon}
      label={label}
      value={value === null ? '—' : `${Math.round(value * 100)}%`}
    >
      {value === null || previous === null ? (
        'Nothing planned'
      ) : (
        <Delta
          value={Math.round(value * 100) - Math.round(previous * 100)}
          format={(n) => `${n}%`}
        />
      )}
    </Shell>
  )
}

function Shell({
  icon,
  label,
  value,
  children
}: {
  icon: React.ReactNode
  label: string
  value: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-[12px] border border-border bg-card p-5">
      <div className="mb-2 flex items-center gap-2 text-[13px] text-text-dim">
        <span className="text-text-faint">{icon}</span>
        {label}
      </div>
      <div className="font-mono text-[26px] leading-none text-text tabular-nums">{value}</div>
      <div className="mt-2 text-[12px] text-text-faint">{children}</div>
    </div>
  )
}

/** Signed, and neutral when nothing moved — a green "+0" reads as praise for nothing. */
function Delta({ value, format }: { value: number; format: (n: number) => string }) {
  if (value === 0) return <>No change vs the period before</>
  return (
    <>
      <span className={value > 0 ? 'text-accent' : 'text-text-dim'}>
        {value > 0 ? '+' : '−'}
        {format(Math.abs(value))}
      </span>{' '}
      vs the period before
    </>
  )
}

/** Status is never colour alone: a tick or a dash carries the same information. */
function QualityRow({ ok, text }: { ok: boolean; text: string }) {
  return (
    <li className="flex items-center gap-2">
      <span className={ok ? 'text-accent' : 'text-prio-med'}>{ok ? '✓' : '!'}</span>
      <span className={ok ? 'text-text-dim' : 'text-text'}>{text}</span>
    </li>
  )
}
