import { useEffect, useState } from 'react'
import { MoneyTodayCard } from '../money/MoneyTodayCard.js'
import type { Task } from '@core/contract/types.js'
import { useLiveQuery } from '../../hooks/useLiveQuery.js'
import { useThisWeek, useToday } from '../../hooks/useToday.js'
import type { Tracking } from '../../hooks/useTracking.js'
import type { Screen } from '../../app/IconRail.js'
import { Button } from '../../ui/Button.js'
import { StatCard } from '../../ui/StatCard.js'
import {
  BarChartIcon,
  CalendarIcon,
  ClockIcon,
  DocumentIcon,
  TrendingUpIcon
} from '../../ui/icons.js'
import { formatDuration, formatLongDate } from '../../lib/format.js'
import { AgendaList } from './AgendaList.js'
import { DayPlanner } from '../planner/DayPlanner.js'
import { TimerHero } from './TimerHero.js'
import { TodayTimeline } from './TodayTimeline.js'
import { TopPriority } from './TopPriority.js'
import { EndOfDayWizard } from '../endofday/EndOfDayWizard.js'

interface Props {
  tracking: Tracking
  onNavigate: (screen: Screen) => void
  /** Opens the task switcher — START never guesses what you meant to work on. */
  onPickTask: () => void
  /** Timestamp bumped by the end-of-day hotkey or the tray menu. */
  endOfDayRequest?: number
  /** Timestamp bumped by clicking the morning "today has no plan yet" notification. */
  planDayRequest?: number
}

export function TodayScreen({
  tracking,
  onNavigate,
  onPickTask,
  endOfDayRequest = 0,
  planDayRequest = 0
}: Props) {
  const today = useToday()
  const week = useThisWeek()
  const [wizardOpen, setWizardOpen] = useState(false)
  const [plannerOpen, setPlannerOpen] = useState(false)

  useEffect(() => {
    if (endOfDayRequest > 0) setWizardOpen(true)
  }, [endOfDayRequest])

  useEffect(() => {
    if (planDayRequest > 0) setPlannerOpen(true)
  }, [planDayRequest])

  const { data: areas } = useLiveQuery((client) => client.areas.list(), ['settings'], [])
  const { data: stats } = useLiveQuery(
    (client) => client.stats.day(today),
    ['sessions', 'tasks'],
    [today]
  )
  const { data: timeline } = useLiveQuery(
    (client) => client.stats.timeline(today),
    ['sessions'],
    [today]
  )
  const { data: tasks } = useLiveQuery(
    // 'active', not 'open': tracking a task marks it in progress, and it must not vanish
    // from the list the moment you start working on it.
    (client) => client.tasks.list({ status: 'active' }),
    ['tasks'],
    []
  )
  const { data: weekStats } = useLiveQuery(
    (client) => client.stats.week(week),
    ['sessions', 'planning'],
    [week]
  )
  // The accepted day plan from the versioned model, not the pre-planner `planned` table.
  const { data: dayPlan } = useLiveQuery(
    (client) => client.plans.day(today),
    ['planning'],
    [today]
  )
  // Appointments share the agenda card with the plan: one timeline, like the phone.
  const { data: todaysEvents } = useLiveQuery(
    (client) => {
      const start = new Date(`${today}T00:00:00`).getTime()
      return client.calendar.eventsInRange(start, start + 86_400_000)
    },
    ['planning'],
    [today]
  )
  const { data: totals } = useLiveQuery(
    (client) => client.tracking.totals(week),
    ['sessions'],
    [week]
  )
  /**
   * How much of today has no task on it yet.
   *
   * START no longer asks what you are working on, so stage hours legitimately sit at zero
   * until the end-of-day division runs. Without this figure that zero reads as "you did
   * nothing today", which is the opposite of what it means.
   */
  const { data: attribution } = useLiveQuery(
    (client) => client.attribution.day(today),
    ['sessions', 'tasks'],
    [today]
  )

  const topTasks = (tasks ?? []).slice(0, 3)
  const agenda = dayPlan?.blocks ?? []
  const currentArea =
    (tracking.segment?.areaId
      ? (areas ?? []).find((area) => area.id === tracking.segment!.areaId)
      : null) ?? null

  /**
   * Picking a task while something already runs switches rather than restarting, so the
   * working session stays continuous.
   */
  const startTask = async (task: Task): Promise<void> => {
    if (tracking.running) await tracking.switchTask(task.id)
    else await tracking.start(task.id)
  }

  return (
    <div className="p-4 wide:px-8 wide:pt-7 wide:pb-8">
      {/* On a phone the title comes first and the status and buttons wrap on a row below it;
          from `wide:` up everything lines up on one row, as the header of a page. */}
      <header className="mb-4 flex flex-col gap-3 wide:mb-7 wide:flex-row wide:items-end wide:justify-between">
        <div className="flex min-w-0 flex-col gap-1 wide:gap-1.5">
          <h1 className="display-title text-[34px] tracking-[-1px] wide:text-[40px]">Today</h1>
          <p className="text-[14px] font-medium text-text-dim wide:text-[15px] wide:font-normal">
            {formatLongDate(new Date())}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 wide:gap-2.5">
          <span
            className={`flex h-[30px] items-center gap-[7px]
              rounded-pill px-3 text-[13px] font-bold
              wide:h-auto wide:gap-2 wide:bg-transparent wide:px-2.5 wide:text-[14px] wide:font-semibold
              ${tracking.running ? 'bg-rail-active text-accent-soft' : 'bg-secondary text-text-dim'}`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                tracking.running
                  ? 'animate-pulse-dot bg-accent shadow-[0_0_0_4px_rgb(93_174_134/0.22)]'
                  : 'bg-text-faint'
              }`}
            />
            {tracking.running ? 'Tracking active' : 'Not tracking'}
          </span>
          <Button
            variant="secondary"
            size="sm"
            icon={<CalendarIcon size={16} />}
            onClick={() => setPlannerOpen(true)}
            className="h-10! gap-2! px-3.5! text-[14px]!"
          >
            {agenda.length > 0 ? 'Edit day plan' : 'Plan day'}
          </Button>
          {/* Quick actions is gone; end of day still needs a way in besides the hotkey. */}
          <Button
            variant="secondary"
            size="sm"
            icon={<DocumentIcon size={16} />}
            onClick={() => setWizardOpen(true)}
            className="h-10! gap-2! px-3.5! text-[14px]!"
          >
            End of day
          </Button>
        </div>
      </header>

      {/* The timeline sits below both columns and spans the full width, so a long day
          has room to be read rather than being squeezed beside the sidebar. */}
      <div className="grid grid-cols-1 gap-4 wide:grid-cols-[minmax(0,1fr)_360px] wide:gap-6">
        {/* ---------------------------------------------------------- left */}
        <div className="flex min-w-0 flex-col gap-4">
          <TimerHero
            segment={tracking.segment}
            elapsedSec={tracking.elapsedSec}
            runElapsedSec={tracking.runElapsedSec}
            runStartedAt={tracking.runStartedAt}
            area={currentArea}
            hotkey="Ctrl+Alt+Space"
            onStart={() => void tracking.start(null)}
            onPick={onPickTask}
            onStop={() => void tracking.stop()}
          />

          <div className="grid grid-cols-2 gap-2 wide:grid-cols-4 wide:gap-3">
          <StatCard
            icon={<ClockIcon size={16} />}
            label="Today"
            value={formatDuration(stats?.trackedMin ?? 0)}
            sub={`of ${formatDuration(stats?.goalMin ?? 480)} goal`}
            progress={{ value: stats?.trackedMin ?? 0, max: stats?.goalMin ?? 480 }}
          />
          <StatCard
            icon={<TrendingUpIcon size={16} />}
            label="This week"
            value={formatDuration(weekStats?.trackedMin ?? 0)}
            sub={`of ${formatDuration(weekStats?.goalMin ?? 2400)} goal`}
            progress={{ value: weekStats?.trackedMin ?? 0, max: weekStats?.goalMin ?? 2400 }}
          />
          {/* Stage hours are what the supervisor sees, so they get their own tile. */}
          <StatCard
            icon={<BarChartIcon size={16} />}
            label="Stage hours"
            value={formatDuration(totals?.stageMin ?? 0)}
            sub={
              totals && totals.otherMin > 0
                ? `${formatDuration(totals.otherMin)} other`
                : `${stats?.sessionCount ?? 0} sessions`
            }
          />
          {/* Untasked time is worked time waiting for a name, and it is the reason the
              stage tile beside it can honestly read zero at four in the afternoon. */}
          <StatCard
            icon={<DocumentIcon size={16} />}
            label="To divide"
            value={formatDuration(attribution?.unattributedMin ?? 0)}
            sub={
              (attribution?.unattributedMin ?? 0) > 0
                ? 'assign at end of day'
                : 'every minute has a task'
            }
          />
          </div>
        </div>

        {/* --------------------------------------------------------- right */}
        <aside className="flex flex-col gap-4">
          <MoneyTodayCard onOpen={() => onNavigate('money')} />
          <TopPriority
            tasks={topTasks}
            activeTaskId={tracking.taskId}
            onSelect={(task) => void startTask(task)}
            onSeeAll={() => onNavigate('tasks')}
          />
          <AgendaList
            date={today}
            blocks={agenda}
            events={todaysEvents ?? []}
            onPlanDay={() => setPlannerOpen(true)}
          />
        </aside>
      </div>

      {/* Full width, below both columns: a long day needs the room. */}
      <section className="mt-4 overflow-x-auto border-t border-border pt-[18px] wide:mt-7 wide:overflow-visible wide:pt-[22px]">
        <TodayTimeline segments={timeline ?? []} />
      </section>

      <DayPlanner date={today} open={plannerOpen} onClose={() => setPlannerOpen(false)} />
      <EndOfDayWizard date={today} open={wizardOpen} onClose={() => setWizardOpen(false)} />
    </div>
  )
}
