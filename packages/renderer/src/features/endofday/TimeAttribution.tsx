import { useEffect, useMemo, useState } from 'react'
import type { Area, DayAttribution, Task, TaskShare } from '@core/contract/types.js'
import { api } from '../../api/client.js'
import { useLiveQuery } from '../../hooks/useLiveQuery.js'
import { Button } from '../../ui/Button.js'
import { Card } from '../../ui/Card.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { CheckIcon, ClockIcon, DocumentIcon, ShieldIcon } from '../../ui/icons.js'
import { formatDuration } from '../../lib/format.js'
import { TaskShareList, minutesFor, sameShares } from '../attribution/TaskShareList.js'

interface Props {
  date: string
  attribution: DayAttribution
  /** Reports the division back so the wizard can save it before moving on. */
  onDraft: (shares: TaskShare[], dirty: boolean) => void
  onSaved: (next: DayAttribution) => void
}

/**
 * Dividing the day's untasked time over the tasks it went to.
 *
 * The step exists because picking a task before you start assumes you know what the next hour
 * holds. Here you say it afterwards, which is the only moment you actually know — and the
 * sheet is built around percentages rather than clock times for the same reason: an afternoon
 * spent flipping between three things has no honest start and end per task, only a share.
 *
 * The step divides the whole day at once. A single stretch is divided from its own editor in
 * the week grid, which is also where hours you forgot to track are entered.
 */
export function TimeAttribution({ date, attribution, onDraft, onSaved }: Props) {
  const [shares, setShares] = useState<TaskShare[]>(attribution.shares)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  // The sheet is opened per day, and a reload of the day is the one thing that may overwrite
  // what is typed — it is the same division, read back from the database.
  useEffect(() => setShares(attribution.shares), [attribution])

  const { data: tasks } = useLiveQuery((client) => client.tasks.list(), ['tasks'], [])
  const { data: areas } = useLiveQuery((client) => client.areas.list(), ['settings'], [])

  const byId = useMemo(() => {
    const map = new Map<string, Task>()
    for (const task of tasks ?? []) map.set(task.id, task)
    return map
  }, [tasks])

  const areaById = useMemo(() => {
    const map = new Map<string, Area>()
    for (const area of areas ?? []) map.set(area.id, area)
    return map
  }, [areas])

  /** The pool being divided. A previous division is undone before a new one is applied. */
  const poolMin = attribution.unattributedMin + attribution.estimatedMin

  const claimedPct = shares.reduce((sum, share) => sum + share.sharePct, 0)
  const dirty = !sameShares(shares, attribution.shares)

  useEffect(() => onDraft(shares, dirty), [shares, dirty, onDraft])

  const stageMin = shares.reduce((sum, share) => {
    const task = byId.get(share.taskId)
    const area = task?.areaId ? areaById.get(task.areaId) : null
    if (!area?.countsAsStageHours) return sum
    return sum + minutesFor(share.sharePct, claimedPct, poolMin)
  }, 0)

  const leftoverMin =
    poolMin -
    shares.reduce((sum, share) => sum + minutesFor(share.sharePct, claimedPct, poolMin), 0)

  const save = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      onSaved(await api.attribution.apply(date, shares))
    } catch (error: unknown) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  if (poolMin === 0) {
    return (
      <Card>
        <EmptyState
          icon={<CheckIcon size={22} />}
          title="Every minute of today already knows which task it belongs to"
          hint={
            attribution.trackedMin > 0
              ? `${formatDuration(attribution.trackedMin)} tracked with a task chosen while the clock ran. Nothing to divide.`
              : 'Nothing was tracked today.'
          }
        />
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      {/* What the division is about, before any of the controls. */}
      <div className="grid grid-cols-1 gap-4 wide:grid-cols-3">
        <Figure
          icon={<ClockIcon size={16} />}
          label="To divide"
          value={formatDuration(poolMin)}
          sub={
            attribution.trackedMin > 0
              ? `${formatDuration(attribution.trackedMin)} already has a task`
              : 'started and stopped without picking'
          }
        />
        <Figure
          icon={<ShieldIcon size={16} />}
          label="Becomes stage hours"
          value={formatDuration(stageMin)}
          sub="from the areas of the tasks below"
          tone={stageMin > 0 ? 'accent' : 'muted'}
        />
        <Figure
          icon={<DocumentIcon size={16} />}
          label="Stays untasked"
          value={formatDuration(Math.max(0, leftoverMin))}
          sub={
            leftoverMin > 0
              ? 'counts as worked, counts toward no task'
              : 'the whole stretch is accounted for'
          }
          tone={leftoverMin > 0 ? 'warn' : 'muted'}
        />
      </div>

      {problem && (
        <div className="rounded-[10px] border border-prio-high/40 bg-prio-high/10 px-4 py-3 text-[13px] text-prio-high">
          {problem}
        </div>
      )}

      <Card title="What did that time go to?">
        <TaskShareList
          shares={shares}
          onChange={setShares}
          poolMin={poolMin}
          tasks={tasks ?? []}
          areaById={areaById}
          emptyHint="Add the tasks you worked on. Leave the shares short of 100% and the rest stays untasked, which is a better answer than a task that did not happen."
        />
      </Card>

      <div className="flex items-center justify-between">
        <span className="text-[13px] text-text-dim">
          {claimedPct > 100
            ? `${claimedPct}% between them, so the shares are read as a ratio`
            : `${claimedPct}% of ${formatDuration(poolMin)} assigned`}
        </span>
        <div className="flex items-center gap-3">
          {dirty ? (
            <span className="text-[13px] text-prio-med">Not saved yet</span>
          ) : (
            attribution.estimatedMin > 0 && (
              <span className="flex items-center gap-1.5 text-[13px] text-accent">
                <CheckIcon size={13} /> Saved
              </span>
            )
          )}
          <Button variant="primary" onClick={() => void save()} disabled={busy || !dirty}>
            Save division
          </Button>
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------- pieces

function Figure({
  icon,
  label,
  value,
  sub,
  tone = 'muted'
}: {
  icon: React.ReactNode
  label: string
  value: string
  sub: string
  tone?: 'muted' | 'accent' | 'warn'
}) {
  const valueTone =
    tone === 'accent' ? 'text-accent' : tone === 'warn' ? 'text-prio-med' : 'text-text'
  return (
    <div className="rounded-[12px] border border-border bg-card p-5">
      <div className="mb-3 flex items-center gap-2 text-text-dim">
        <span className="text-accent">{icon}</span>
        <span className="text-[13px]">{label}</span>
      </div>
      <div className={`font-mono text-[26px] leading-none font-semibold ${valueTone}`}>{value}</div>
      <div className="mt-2 text-[13px] text-text-dim">{sub}</div>
    </div>
  )
}
