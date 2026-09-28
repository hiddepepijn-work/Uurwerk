import { useMemo, useState } from 'react'
import type { BreakdownFilter, RangePreset, StatisticsOverview } from '@core/contract/types.js'
import { useLiveQuery } from '../../hooks/useLiveQuery.js'
import { Card, CardAction } from '../../ui/Card.js'
import { useCountUp } from '../../ui/useCountUp.js'
import { useSlidingThumb } from '../../ui/useSlidingThumb.js'
import { formatDuration } from '../../lib/format.js'
import {
  BarChartIcon,
  CalendarIcon,
  CheckIcon,
  ClockIcon,
  ShieldIcon,
  TrendingUpIcon
} from '../../ui/icons.js'
import { areaFill } from '../agenda/agenda-model.js'
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
      .map((area) => ({ id: area.id, name: area.name, color: areaFill(area) }))

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
    'h-11 w-full appearance-none rounded-input bg-input pr-9 pl-3 text-[14px] font-semibold text-text outline-none wide:w-auto wide:pl-3.5'

  return (
    <div className="px-4 pt-4 pb-6 wide:px-8 wide:py-7">
      <header className="mb-4 flex flex-col gap-4 wide:mb-5 wide:flex-row wide:flex-wrap wide:items-end wide:justify-between">
        <div className="min-w-0">
          <h1 className="display-title text-[34px] wide:text-[40px]">Statistics</h1>
          <p className="mt-1.5 text-[14px] font-semibold text-text-dim wide:text-[15px] wide:font-normal">
            {data.from} – {data.to}
          </p>
        </div>

        {/* Filters in one row above the charts, so what you changed is next to what changed. */}
        <div className="flex flex-col gap-2.5 wide:flex-row wide:flex-wrap wide:items-center">
          <RangeControl preset={preset} onChange={setPreset} />

          {/* Area and organization are independent filters, deliberately: the same employer
              hosts internship work and work that is not. */}
          <div className="grid grid-cols-2 gap-2 wide:flex wide:gap-2.5">
            <span className="relative block">
              <select value={areaId} onChange={(e) => setAreaId(e.target.value)} className={select}>
                <option value="">Area: all</option>
                {(areas ?? []).map((area) => (
                  <option key={area.id} value={area.id}>
                    {area.name}
                  </option>
                ))}
              </select>
              <Chevron />
            </span>

            <span className="relative block">
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
              <Chevron />
            </span>
          </div>
        </div>
      </header>

      <div className="mb-4 grid grid-cols-2 gap-2.5 wide:mb-5 wide:grid-cols-3 wide:gap-3 xl:grid-cols-6">
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

      <div className="mb-4 grid grid-cols-1 gap-4 wide:mb-5 wide:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] wide:gap-5">
        <Card
          title={data.daily ? 'Hours by day' : 'Hours by week'}
          action={
            <CardAction onClick={() => setShowTable((value) => !value)}>
              {showTable ? 'Show chart' : 'Show table'}
            </CardAction>
          }
        >
          <div className="mb-4 flex flex-wrap gap-1.5 wide:gap-2">
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
                  className={`flex h-[30px] items-center gap-1.5 rounded-pill bg-input px-[11px] text-[13px] font-bold transition-colors wide:h-8 wide:gap-[7px] wide:px-3 ${
                    on ? 'text-text' : 'text-text-faint'
                  }`}
                >
                  <span
                    className="h-2 w-2 rounded-full"
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

          <p className="mt-3.5 text-[12px] leading-normal font-medium text-text-faint wide:text-[13px] wide:font-normal">
            {data.daily
              ? 'This week, day by day. Screen time is how long the laptop was awake — context for the tracked hours, not part of them.'
              : 'One column per week. Screen time is how long the laptop was awake, not time you logged.'}
          </p>
        </Card>

        <div className="flex flex-col gap-4 wide:gap-5">
          <Card title="Time by area">
            <ShareBars areas={data.areas} />
          </Card>

          <Card title="Data quality">
            <div className="flex items-center gap-5">
              {/* A ring rather than a bare number: how full it is reads before the digits do. */}
              <div
                className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full"
                style={{
                  background: `conic-gradient(var(--color-accent) 0 ${data.quality.score * 100}%, var(--color-border) ${data.quality.score * 100}% 100%)`
                }}
              >
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-card font-display text-[15px] font-bold text-text tabular-nums">
                  {Math.round(data.quality.score * 100)}%
                </span>
              </div>
              <ul className="flex min-w-0 flex-1 flex-col gap-2.5 text-[14px]">
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

      <div className="grid grid-cols-1 gap-4 wide:grid-cols-2 wide:gap-5">
        <Card title="Projects">
          {data.projects.length === 0 ? (
            <p className="text-[13px] text-text-faint">Nothing tracked in this period.</p>
          ) : (
            <ul className="flex flex-col gap-3.5">
              {data.projects.slice(0, 6).map((project, index) => {
                const widest = data.projects[0]?.minutes ?? 1
                return (
                  <li key={project.projectId ?? 'none'} className="flex items-center gap-3">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        project.countsAsStageHours ? 'bg-accent' : 'bg-text-faint'
                      }`}
                      title={
                        project.countsAsStageHours
                          ? 'Counts toward internship hours'
                          : 'Does not count toward internship hours'
                      }
                    />
                    <span className="w-28 shrink-0 truncate text-[14px] font-bold text-text wide:w-40">
                      {project.name}
                    </span>
                    <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-input">
                      <span
                        className={`animate-grow-x block h-full rounded-full ${
                          project.countsAsStageHours ? 'bg-accent' : 'bg-text-dim'
                        }`}
                        style={{
                          animationDelay: `${index * 50}ms`,
                          width: `${Math.max(2, (project.minutes / widest) * 100)}%`
                        }}
                      />
                    </span>
                    <span className="w-[66px] shrink-0 text-right font-mono text-[14px] font-bold text-text tabular-nums">
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
            <table className="w-full text-[14px]">
              <thead>
                <tr className="label-caps tracking-[0.8px]">
                  <th className="pb-2 text-left font-bold">Work type</th>
                  <th className="pb-2 text-right font-bold">Planned</th>
                  <th className="pb-2 text-right font-bold">Actual</th>
                  <th className="pb-2 pl-2 text-right font-bold">Difference</th>
                </tr>
              </thead>
              <tbody>
                {data.workTypes.slice(0, 6).map((row, index) => {
                  const delta = row.actualMin - row.plannedMin
                  return (
                    <tr
                      key={row.workTypeId ?? 'none'}
                      className="animate-rise h-10 border-t border-border"
                      style={{ '--i': index } as React.CSSProperties}
                    >
                      <td className="font-semibold text-text">{row.name}</td>
                      <td className="text-right font-mono text-text-dim tabular-nums">
                        {formatDuration(row.plannedMin)}
                      </td>
                      <td className="text-right font-mono font-bold text-accent-soft tabular-nums">
                        {formatDuration(row.actualMin)}
                      </td>
                      <td
                        className={`pl-2 text-right font-mono font-semibold tabular-nums ${
                          row.plannedMin === 0
                            ? 'text-text-faint'
                            : delta > 0
                              ? 'text-warn'
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
        <div className="mt-4 flex items-start gap-3.5 rounded-card bg-rail-active px-4 py-4 wide:mt-5 wide:px-5">
          <span className="mt-px shrink-0 text-accent-soft">
            <ShieldIcon size={22} />
          </span>
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="label-caps tracking-[0.8px] text-accent-soft">Worth knowing</span>
            {data.insights.map((insight) => (
              <span key={insight.kind} className="text-[14px] leading-snug text-text">
                {insight.text}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// -------------------------------------------------------------------- tiles

/** The range switch; its own component so the sliding thumb measures once it is on screen. */
function RangeControl({ preset, onChange }: { preset: RangePreset; onChange: (preset: RangePreset) => void }) {
  const rangeThumb = useSlidingThumb<HTMLDivElement>(preset)
  return (
    <div
      ref={rangeThumb.containerRef}
      className="relative flex gap-1 rounded-[16px] bg-card p-1 wide:gap-0 wide:rounded-button"
    >
      {/* The highlight slides to the chosen range instead of jumping. */}
      <span
        aria-hidden
        className="rounded-input bg-rail-active wide:rounded-[11px] wide:bg-text"
        style={rangeThumb.thumbStyle}
      />
      {RANGES.map((range) => (
        <button
          key={range.id}
          data-active={preset === range.id}
          onClick={() => onChange(range.id)}
          className={`relative z-[1] h-10 flex-1 rounded-input px-3.5 text-[14px] font-bold transition-colors wide:h-9 wide:flex-none wide:rounded-[11px] ${
            preset === range.id
              ? 'text-accent-soft wide:text-bg'
              : 'text-text-dim hover:text-text'
          }`}
        >
          {range.label}
        </button>
      ))}
    </div>
  )
}

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
  const shown = useCountUp(value)
  return (
    // The same tile as ui/StatCard, so Statistics, Projects and Report read as one family.
    <div className="flex flex-col gap-2 rounded-card bg-card p-4">
      <div className="flex items-center gap-[7px]">
        <span className="text-accent-soft">{icon}</span>
        <span className="text-[13px] font-bold text-text-dim">{label}</span>
      </div>
      <div className="font-display text-[30px] leading-none font-bold tracking-[-0.6px] text-text tabular-nums">
        {shown}
      </div>
      <div className="text-[13px] leading-snug font-semibold text-text-faint wide:font-normal">{children}</div>
    </div>
  )
}

/** Signed, and neutral when nothing moved — a green "+0" reads as praise for nothing. */
function Delta({ value, format }: { value: number; format: (n: number) => string }) {
  if (value === 0) return <>No change vs the period before</>
  return (
    <>
      <span className={value > 0 ? 'font-semibold text-accent-soft' : 'font-semibold text-text-dim'}>
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
    <li className="flex items-center gap-2.5">
      <span
        className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[13px] font-bold ${
          ok ? 'bg-rail-active text-accent-soft' : 'bg-warn-soft text-warn'
        }`}
      >
        {ok ? <CheckIcon size={12} /> : '!'}
      </span>
      <span className={`font-medium ${ok ? 'text-text-dim' : 'text-text'}`}>{text}</span>
    </li>
  )
}

/** The select's arrow; the native one is hidden so the field can be a flat Inkt input. */
function Chevron() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-text-dim"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}
