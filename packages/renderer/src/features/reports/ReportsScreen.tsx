import { useEffect, useState } from 'react'
import type { WeekReport } from '@core/contract/types.js'
import { nextWeek, previousWeek, toIsoWeek } from '@core/util/time.js'
import { api } from '../../api/client.js'
import { useLiveQuery } from '../../hooks/useLiveQuery.js'
import { Button } from '../../ui/Button.js'
import { StatCard } from '../../ui/StatCard.js'
import {
  BarChartIcon,
  CalendarIcon,
  CheckIcon,
  ClockIcon,
  DocumentIcon,
  SendIcon
} from '../../ui/icons.js'
import { formatDuration } from '../../lib/format.js'
import { HoursTable } from './HoursTable.js'
import { ReportScreenshots } from './ReportScreenshots.js'
import { NextWeekPlan } from './NextWeekPlan.js'

const SUMMARY_MAX = 1000

/**
 * The weekly report: everything the supervisor will receive, on one page, before it exists
 * as a file.
 *
 * The order matters. Numbers first, because they are not up for negotiation; then the
 * images, which are; then your own words, which are the only part a supervisor really
 * reads. Generating the .docx is the last step and it changes nothing — the document is a
 * rendering of what is already on this screen, so what you approve here is what is sent.
 */
export function ReportsScreen() {
  const [week, setWeek] = useState(() => toIsoWeek(Date.now()))
  const [summary, setSummary] = useState('')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  /** What sending actually did — draft opened, or message sent. */
  const [notice, setNotice] = useState<string | null>(null)
  const [generated, setGenerated] = useState<string | null>(null)

  const { data: report, refetch } = useLiveQuery<WeekReport>(
    (client) => client.reports.build(week),
    ['sessions', 'planning', 'artifacts', 'reports'],
    [week]
  )

  // The box follows the week, but never overwrites something you are in the middle of.
  useEffect(() => {
    if (!report || dirty) return
    setSummary(report.summary)
    setGenerated(report.docxPath)
    setProblem(null)
  }, [report, dirty])

  useEffect(() => {
    setDirty(false)
    setNotice(null)
  }, [week])

  const saveSummary = async (): Promise<void> => {
    await api.reports.saveSummary(week, summary)
    setDirty(false)
  }

  const generate = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      if (dirty) await saveSummary()
      setGenerated(await api.reports.generateDocx(week))
      refetch()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const send = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    setNotice(null)
    try {
      if (dirty) await saveSummary()
      // Draft mode reports back that it opened a draft, not that it sent anything. Showing
      // its own words keeps the screen from claiming more than actually happened.
      const outcome = await api.reports.send(week)
      setNotice(outcome.message)
      refetch()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  if (!report) return null

  const approved = report.screenshots.filter((shot) => shot.included).length
  const delta = report.totalTrackedMin - report.totalPlannedMin

  return (
    <div className="p-8">
      <header className="mb-7 flex items-start justify-between gap-6">
        <div>
          <h1 className="text-[32px] leading-tight font-semibold">Report</h1>
          <p className="mt-1 text-[14px] text-text-dim">
            {report.from} – {report.to} · written in Dutch, for your supervisor
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex gap-1">
            <Button variant="secondary" size="sm" onClick={() => setWeek(previousWeek(week))}>
              ←
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setWeek(toIsoWeek(Date.now()))}>
              This week
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setWeek(nextWeek(week))}>
              →
            </Button>
          </div>
        </div>
      </header>

      {problem && (
        <div className="mb-6 rounded-[10px] border border-prio-med/40 bg-prio-med/10 px-4 py-3 text-[13px] text-prio-med">
          {problem}
        </div>
      )}

      {notice && (
        <div className="mb-6 rounded-[10px] border border-accent/30 bg-accent/5 px-4 py-3 text-[13px] text-text">
          {notice}
        </div>
      )}

      <div className="mb-7 grid grid-cols-4 gap-4">
        <StatCard
          icon={<ClockIcon size={16} />}
          label="Tracked"
          value={formatDuration(report.totalTrackedMin)}
        />
        <StatCard
          icon={<CalendarIcon size={16} />}
          label="Planned"
          value={formatDuration(report.totalPlannedMin)}
          sub={
            report.totalPlannedMin === 0
              ? 'nothing was planned'
              : `${delta >= 0 ? '+' : '−'}${formatDuration(Math.abs(delta))} against plan`
          }
        />
        <StatCard
          icon={<CheckIcon size={16} />}
          label="Completed"
          value={`${report.completedTasks} / ${report.totalTasks}`}
          sub="tasks finished this week"
        />
        <StatCard
          icon={<BarChartIcon size={16} />}
          label="Approved images"
          value={String(approved)}
          sub={`of ${report.screenshots.length} captured`}
        />
      </div>

      <Section title="Hours" hint="Planned against actually tracked, per task.">
        <HoursTable report={report} />
      </Section>

      <Section
        title="Images"
        hint="Only approved frames are written into the document. Approve them per day in the end-of-day wizard, or here."
      >
        <ReportScreenshots
          screenshots={report.screenshots}
          timelapse={report.timelapse}
          onToggle={async (id, included) => {
            await api.capture.setIncluded(id, included)
          }}
          onOpen={(path) => void api.reports.openFile(path)}
        />
      </Section>

      <Section
        title="Summary"
        hint="Written for you from the week's numbers — rewrite it in your own words. This is the part your supervisor actually reads."
      >
        <textarea
          value={summary}
          maxLength={SUMMARY_MAX}
          onChange={(event) => {
            setSummary(event.target.value)
            setDirty(true)
          }}
          onBlur={() => {
            if (dirty) void saveSummary()
          }}
          rows={8}
          className="w-full resize-none rounded-[10px] border border-border bg-bg p-4 text-[14px]
            leading-relaxed text-text outline-none placeholder:text-text-faint focus:border-accent"
        />
        <div className="mt-2 flex items-center justify-between text-[12px]">
          <span className={dirty ? 'text-prio-med' : 'text-text-faint'}>
            {dirty ? 'Unsaved — saves when you click away' : 'Saved'}
          </span>
          <span className="text-text-faint">
            {summary.length} / {SUMMARY_MAX}
          </span>
        </div>
      </Section>

      <Section title="Next week" hint="Copied into the document so your supervisor knows what is coming.">
        <NextWeekPlan blocks={report.nextWeekPlanning} />
      </Section>

      <div className="mt-8 flex items-center justify-between rounded-[12px] border border-border bg-card p-5">
        <div className="min-w-0">
          <div className="text-[14px] text-text">
            {generated ? 'Document written' : 'No document for this week yet'}
          </div>
          <div className="mt-0.5 truncate text-[13px] text-text-dim">
            {generated ?? 'Generating writes a .docx you can attach or print.'}
          </div>
          {/* Only ever set by a real send; opening a draft deliberately leaves it blank. */}
          {report.sentAt && (
            <div className="mt-1 text-[13px] text-accent">
              Sent {new Date(report.sentAt).toLocaleString('en-GB')}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-3">
          {generated && (
            <Button variant="ghost" onClick={() => void api.reports.openFile(generated)}>
              Open
            </Button>
          )}
          <Button
            variant="secondary"
            icon={<DocumentIcon size={15} />}
            disabled={busy}
            onClick={() => void generate()}
          >
            {generated ? 'Regenerate' : 'Generate .docx'}
          </Button>
          <Button
            variant="primary"
            icon={<SendIcon size={15} />}
            disabled={busy}
            onClick={() => void send()}
          >
            Send
          </Button>
        </div>
      </div>
    </div>
  )
}

function Section({
  title,
  hint,
  children
}: {
  title: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <section className="mb-8">
      <h2 className="text-[16px] font-semibold">{title}</h2>
      {hint && <p className="mt-1 mb-4 max-w-2xl text-[13px] leading-relaxed text-text-dim">{hint}</p>}
      {!hint && <div className="mb-4" />}
      {children}
    </section>
  )
}
