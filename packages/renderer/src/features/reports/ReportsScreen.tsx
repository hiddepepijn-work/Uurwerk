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
    <div className="px-4 pt-4 pb-6 wide:px-8 wide:py-7">
      <header className="mb-4 flex flex-col gap-4 wide:mb-5 wide:flex-row wide:items-end wide:justify-between wide:gap-6">
        <div className="min-w-0">
          <h1 className="display-title text-[34px] wide:text-[40px]">Report</h1>
          <p className="mt-1.5 text-[14px] leading-snug font-medium text-text-dim wide:text-[15px] wide:font-normal">
            {report.from} – {report.to} · written in Dutch, for your supervisor
          </p>
        </div>

        <div className="flex shrink-0 gap-2 wide:gap-1.5 wide:rounded-button wide:bg-card wide:p-1">
          <Button
            variant="secondary"
            className="text-[17px] wide:h-[38px] wide:rounded-[11px] wide:text-[16px]"
            onClick={() => setWeek(previousWeek(week))}
          >
            ←
          </Button>
          <Button
            variant="secondary"
            className="flex-1 text-[15px] wide:h-[38px] wide:flex-none wide:rounded-[11px] wide:text-[14px]"
            onClick={() => setWeek(toIsoWeek(Date.now()))}
          >
            This week
          </Button>
          <Button
            variant="secondary"
            className="text-[17px] wide:h-[38px] wide:rounded-[11px] wide:text-[16px]"
            onClick={() => setWeek(nextWeek(week))}
          >
            →
          </Button>
        </div>
      </header>

      {problem && (
        <div className="mb-4 rounded-[16px] bg-warn-soft px-3.5 py-3 text-[14px] leading-snug font-semibold text-warn wide:mb-5">
          {problem}
        </div>
      )}

      {notice && (
        <div className="mb-4 rounded-[16px] bg-rail-active px-3.5 py-3 text-[14px] leading-snug font-semibold text-accent-soft wide:mb-5">
          {notice}
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-2.5 wide:mb-5 wide:grid-cols-4 wide:gap-3.5">
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

      {/* Side by side once the window is wide enough for two columns of prose. */}
      <div className="min-[1180px]:grid min-[1180px]:grid-cols-2 min-[1180px]:gap-5">
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
            className="w-full resize-none rounded-input bg-input p-3.5 text-[15px] leading-normal font-medium
              text-text outline-none placeholder:text-text-faint wide:text-[14px] wide:font-normal"
          />
          <div className="mt-2 flex items-center justify-between text-[13px] font-semibold wide:font-bold">
            <span className={dirty ? 'text-warn' : 'text-accent-soft'}>
              {dirty ? 'Unsaved — saves when you click away' : 'Saved'}
            </span>
            <span className="text-text-faint tabular-nums">
              {summary.length} / {SUMMARY_MAX}
            </span>
          </div>
        </Section>

        <Section title="Next week" hint="Copied into the document so your supervisor knows what is coming.">
          <NextWeekPlan blocks={report.nextWeekPlanning} />
        </Section>
      </div>

      <div className="flex flex-col gap-3.5 rounded-[22px] bg-card p-4 wide:flex-row wide:items-center wide:gap-[18px] wide:px-6 wide:py-5">
        <span className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-button bg-input text-text-dim wide:flex">
          <DocumentIcon size={20} />
        </span>
        <div className="min-w-0 wide:flex-1">
          <div className="text-[16px] font-bold text-text">
            {generated ? 'Document written' : 'No document for this week yet'}
          </div>
          <div className="mt-1 text-[13px] font-medium break-all text-text-dim wide:truncate wide:font-normal wide:break-normal">
            {generated ?? 'Generating writes a .docx you can attach or print.'}
          </div>
          {/* Only ever set by a real send; opening a draft deliberately leaves it blank. */}
          {report.sentAt && (
            <div className="mt-1 text-[13px] font-bold text-accent-soft">
              Sent {new Date(report.sentAt).toLocaleString('en-GB')}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2 wide:gap-2.5">
          {generated && (
            <Button variant="ghost" onClick={() => void api.reports.openFile(generated)}>
              Open
            </Button>
          )}
          <Button
            variant="secondary"
            className="flex-1 wide:flex-none"
            icon={<DocumentIcon size={17} />}
            disabled={busy}
            onClick={() => void generate()}
          >
            {generated ? 'Regenerate' : 'Generate .docx'}
          </Button>
          <Button
            variant="primary"
            icon={<SendIcon size={17} />}
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
    // A plain section on the phone, where the table inside is the card; a card of its own on
    // the desktop, where the table sits flat inside it.
    <section className="mb-4 wide:mb-5 wide:rounded-[22px] wide:bg-card wide:px-6 wide:py-[22px]">
      <h2 className="font-display text-[24px] font-bold tracking-[-0.4px] wide:text-[22px] wide:tracking-normal">
        {title}
      </h2>
      {hint && (
        <p className="mt-[3px] mb-2.5 max-w-2xl text-[14px] leading-snug font-medium text-text-dim wide:mt-1 wide:mb-4 wide:font-normal">
          {hint}
        </p>
      )}
      {!hint && <div className="mb-2.5 wide:mb-4" />}
      {children}
    </section>
  )
}
