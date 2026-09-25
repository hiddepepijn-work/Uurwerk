import { useEffect, useState } from 'react'
import type {
  Artifact,
  DayAttribution,
  DayReport,
  DayReview,
  PublishFlags,
  TaskShare
} from '@core/contract/types.js'
import { NO_PUBLISH } from '@core/contract/types.js'
import { api, events } from '../../api/client.js'
import { Button } from '../../ui/Button.js'
import { Modal } from '../../ui/Modal.js'
import { PriorityDot } from '../../ui/PriorityDot.js'
import { CheckIcon, DocumentIcon, FilmIcon, SendIcon, ShieldIcon } from '../../ui/icons.js'
import { formatDuration, formatLongDate } from '../../lib/format.js'
import { PublishSelection } from './PublishSelection.js'
import { ScreenshotGrid } from './ScreenshotGrid.js'
import { TimeAttribution } from './TimeAttribution.js'

/**
 * The steps, by name rather than by number.
 *
 * 'attribute' only appears on a day that has time with no task on it, so the list is built
 * per day and indexes into it mean nothing on their own — which is exactly why the steps are
 * keyed. Adding a conditional step to a positional list is how a wizard starts showing the
 * wrong panel.
 */
type StepKey = 'attribute' | 'review' | 'screenshots' | 'summary' | 'publish'

const LABELS: Record<StepKey, string> = {
  attribute: 'Divide time',
  review: 'Review summary',
  screenshots: 'Review screenshots',
  summary: 'Day summary',
  publish: 'Publish'
}

const BASE_STEPS: StepKey[] = ['review', 'screenshots', 'summary', 'publish']

const SUMMARY_MAX = 1000

interface Props {
  date: string
  open: boolean
  onClose: () => void
}

/**
 * End of day: review, approve, publish.
 *
 * The order of the steps is the point. You see the numbers, then you approve the images,
 * then you read back exactly what is about to leave the machine, and only then can you
 * press Publish. There is no path that skips the middle two steps.
 */
export function EndOfDayWizard({ date, open, onClose }: Props) {
  const [step, setStep] = useState(0)
  const [review, setReview] = useState<DayReview | null>(null)
  const [attribution, setAttribution] = useState<DayAttribution | null>(null)
  /** The division as typed, so Continue can save it without a second click. */
  const [draft, setDraft] = useState<{ shares: TaskShare[]; dirty: boolean }>({
    shares: [],
    dirty: false
  })
  const [day, setDay] = useState<DayReport | null>(null)
  const [screenshots, setScreenshots] = useState<Artifact[]>([])
  const [summary, setSummary] = useState('')
  const [flags, setFlags] = useState<PublishFlags>(NO_PUBLISH)
  const [timelapse, setTimelapse] = useState<Artifact | null>(null)
  const [encoding, setEncoding] = useState<{ done: number; total: number } | null>(null)
  /** Only used to predict how long encoding will take, so a stale value is harmless. */
  const [fps, setFps] = useState(16)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const reloadArtifacts = async (): Promise<void> => {
    const [shots, films] = await Promise.all([
      api.capture.listByDay(date, 'screenshot'),
      api.capture.listByDay(date, 'timelapse')
    ])
    setScreenshots(shots)
    setTimelapse(films[0] ?? null)
  }

  useEffect(() => {
    if (!open) return
    setStep(0)
    setProblem(null)
    setDone(false)
    setEncoding(null)

    void (async () => {
      const [reviewData, dayData, attributionData] = await Promise.all([
        api.days.review(date),
        api.days.get(date),
        api.attribution.day(date)
      ])
      setReview(reviewData)
      setDay(dayData)
      setAttribution(attributionData)
      setSummary(dayData.summary)
      setFlags(dayData.flags)
      setFps((await api.settings.get()).timelapseFps)
      await reloadArtifacts()
    })().catch((error: unknown) => setProblem(errorText(error)))
    // reloadArtifacts closes over `date`, which is already a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, date])

  /** Encoding takes seconds, so it reports where it is rather than freezing the button. */
  useEffect(() => {
    if (!open) return
    return events.on('timelapse:progress', (payload) => {
      if (payload.date === date) setEncoding({ done: payload.done, total: payload.total })
    })
  }, [open, date])

  /**
   * The step only appears where there is something to divide — or something already divided,
   * so a division can be corrected as easily as it was made.
   */
  const needsAttribution =
    attribution !== null && attribution.unattributedMin + attribution.estimatedMin > 0
  const steps: StepKey[] = needsAttribution ? ['attribute', ...BASE_STEPS] : BASE_STEPS
  const current = steps[Math.min(step, steps.length - 1)]!

  /**
   * Continue saves an unsaved division before moving on.
   *
   * The next step shows the day's numbers, and those numbers come from the segments this
   * step writes. Advancing past a typed-but-unsaved division would show figures that
   * contradict what is on screen behind them.
   */
  const advance = async (): Promise<void> => {
    if (current === 'attribute' && draft.dirty) {
      setBusy(true)
      try {
        setAttribution(await api.attribution.apply(date, draft.shares))
        setReview(await api.days.review(date))
        setProblem(null)
      } catch (error) {
        setProblem(errorText(error))
        setBusy(false)
        return
      }
      setBusy(false)
    }
    setStep((s) => s + 1)
  }

  const includedCount = screenshots.filter((s) => s.included).length

  const toggleShot = async (id: string, included: boolean): Promise<void> => {
    await api.capture.setIncluded(id, included)
    setScreenshots((current) => current.map((s) => (s.id === id ? { ...s, included } : s)))
  }

  const approveAll = async (included: boolean): Promise<void> => {
    await api.capture.approveDay(date, included)
    setScreenshots((current) => current.map((s) => ({ ...s, included })))
  }

  const deleteShot = async (id: string): Promise<void> => {
    await api.capture.remove(id)
    setScreenshots((current) => current.filter((s) => s.id !== id))
  }

  const makeTimelapse = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    setEncoding({ done: 0, total: includedCount })
    try {
      const built = await api.capture.buildTimelapse(date)
      setTimelapse(built)
      setReview((current) => (current ? { ...current, hasTimelapse: built !== null } : current))
    } catch (error) {
      setProblem(errorText(error))
    } finally {
      setEncoding(null)
      setBusy(false)
    }
  }

  const saveDraft = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.days.saveSummary(date, summary)
      await api.days.saveFlags(date, flags)
      setProblem(null)
      onClose()
    } catch (error) {
      setProblem(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  const publish = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.days.saveSummary(date, summary)
      await api.days.saveFlags(date, flags)
      const published = await api.days.publish(date)
      setDay(published)
      setDone(true)
      setProblem(null)
    } catch (error) {
      // The summary and the flags were saved before the upload was attempted, so a failure
      // here loses nothing. The day stays unpublished and the error says why.
      setProblem(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={960}
      title="End of day & publish"
      subtitle="Review your day, add a summary, select what to share and publish to your supervisor."
      footer={
        <>
          <Button
            variant="secondary"
            icon={<DocumentIcon size={15} />}
            onClick={() => void saveDraft()}
            disabled={busy}
          >
            Save as draft
          </Button>

          <div className="flex items-center gap-3">
            {step > 0 && (
              <Button variant="ghost" onClick={() => setStep((s) => s - 1)} disabled={busy}>
                Back
              </Button>
            )}
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            {step < steps.length - 1 ? (
              <Button variant="primary" onClick={() => void advance()} disabled={busy}>
                Continue to {LABELS[steps[step + 1]!].toLowerCase()} →
              </Button>
            ) : (
              <Button
                variant="primary"
                icon={<SendIcon size={15} />}
                onClick={() => void publish()}
                disabled={busy || done || !Object.values(flags).some(Boolean)}
              >
                {done ? 'Published' : 'Publish'}
              </Button>
            )}
          </div>
        </>
      }
    >
      <Steps steps={steps} current={step} onSelect={setStep} />

      {problem && (
        <div className="mb-6 rounded-[10px] border border-prio-med/40 bg-prio-med/10 px-4 py-3 text-[13px] text-prio-med">
          {problem}
        </div>
      )}

      {current === 'attribute' && attribution && (
        <TimeAttribution
          date={date}
          attribution={attribution}
          onDraft={(shares, dirty) => setDraft({ shares, dirty })}
          onSaved={(next) => {
            setAttribution(next)
            setDraft({ shares: next.shares, dirty: false })
            // The day's figures are derived from what was just written.
            void api.days.review(date).then(setReview)
          }}
        />
      )}

      {current === 'review' && review && (
        <div className="grid grid-cols-1 gap-6 wide:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
          <div className="flex flex-col gap-5">
            <DaySummaryCard date={date} review={review} />
            <TopActivitiesCard review={review} />
          </div>

          <div className="flex flex-col gap-5">
            <SummaryBox value={summary} onChange={setSummary} />
            <PublishSelection
              flags={flags}
              onChange={setFlags}
              counts={{ screenshots: includedCount, timelapse: review.hasTimelapse ? 1 : 0 }}
            />
          </div>
        </div>
      )}

      {current === 'screenshots' && (
        <div className="flex flex-col gap-6">
          <ScreenshotGrid
            screenshots={screenshots}
            onToggle={(id, on) => void toggleShot(id, on)}
            onApproveAll={(on) => void approveAll(on)}
            onDelete={(id) => void deleteShot(id)}
          />
          <TimelapsePanel
            approvedCount={includedCount}
            fps={fps}
            timelapse={timelapse}
            encoding={encoding}
            busy={busy}
            onBuild={() => void makeTimelapse()}
            onOpen={(path) => void api.reports.openFile(path)}
          />
        </div>
      )}

      {current === 'summary' && review && (
        <div className="flex flex-col gap-5">
          <h3 className="text-[15px] font-semibold">Day summary</h3>
          <div className="rounded-[12px] border border-border bg-bg p-5 text-[14px] leading-relaxed whitespace-pre-wrap text-text" data-selectable>
            {summary.trim() || <span className="text-text-faint">No summary written.</span>}
          </div>
          <DaySummaryCard date={date} review={review} />
        </div>
      )}

      {current === 'publish' && review && (
        <PublishPreview
          date={date}
          review={review}
          flags={flags}
          includedCount={includedCount}
          publishedAt={day?.publishedAt ?? null}
          onUnpublish={async () => {
            const updated = await api.days.unpublish(date)
            setDay(updated)
            setDone(false)
          }}
        />
      )}
    </Modal>
  )
}

// ------------------------------------------------------------------- pieces

function Steps({
  steps,
  current,
  onSelect
}: {
  steps: StepKey[]
  current: number
  onSelect: (step: number) => void
}) {
  return (
    <ol className="mb-7 flex items-center gap-3 border-b border-border pb-6">
      {steps.map((key, index) => {
        const label = LABELS[key]
        const state = index === current ? 'active' : index < current ? 'done' : 'todo'
        return (
          <li key={label} className="flex flex-1 items-center gap-3">
            <button
              onClick={() => onSelect(index)}
              className="flex items-center gap-2.5 whitespace-nowrap"
            >
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-full text-[12px] font-semibold
                  ${
                    state === 'active'
                      ? 'bg-accent text-[#06210F]'
                      : state === 'done'
                        ? 'bg-accent/20 text-accent'
                        : 'border border-border-strong text-text-faint'
                  }`}
              >
                {state === 'done' ? <CheckIcon size={12} /> : index + 1}
              </span>
              <span
                className={`text-[13px] ${state === 'active' ? 'font-medium text-accent' : 'text-text-dim'}`}
              >
                {label}
              </span>
            </button>
            {index < steps.length - 1 && <span className="h-px flex-1 bg-border" />}
          </li>
        )
      })}
    </ol>
  )
}

function DaySummaryCard({ date, review }: { date: string; review: DayReview }) {
  const rows: Array<[string, string, string?]> = [
    ['Total tracked time', formatDuration(review.trackedMin)],
    ['Focus time', formatDuration(review.focusMin), 'text-accent'],
    ['Break time', formatDuration(review.breakMin), 'text-prio-med'],
    ['Sessions', String(review.sessionCount)],
    ['Completed tasks', `${review.completedTasks} / ${review.totalTasks}`]
  ]

  return (
    <div className="rounded-[12px] border border-border bg-bg p-5">
      <h3 className="mb-1 text-[15px] font-semibold">Day summary</h3>
      <p className="mb-4 text-[13px] text-text-dim">{formatLongDate(new Date(`${date}T12:00:00`))}</p>
      <dl className="flex flex-col gap-3">
        {rows.map(([label, value, tone]) => (
          <div key={label} className="flex items-center justify-between text-[14px]">
            <dt className={tone ?? 'text-text-dim'}>{label}</dt>
            <dd className={`font-mono ${tone ?? 'text-text'}`}>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function TopActivitiesCard({ review }: { review: DayReview }) {
  return (
    <div className="rounded-[12px] border border-border bg-bg p-5">
      <h3 className="mb-4 text-[15px] font-semibold">Top activities</h3>
      {review.topActivities.length === 0 ? (
        <p className="text-[13px] text-text-faint">Nothing tracked today.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {review.topActivities.map((activity) => (
            <li key={activity.taskId ?? activity.taskTitle} className="flex items-start gap-3">
              {activity.priority ? (
                <span className="pt-1.5">
                  <PriorityDot priority={activity.priority} />
                </span>
              ) : (
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-text-faint" />
              )}
              <span className="min-w-0 flex-1 text-[14px] text-text">{activity.taskTitle}</span>
              <span className="shrink-0 font-mono text-[13px] text-text-dim">
                {formatDuration(activity.minutes)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Build the day into a video, from the frames approved directly above it.
 *
 * It sits under the grid rather than in its own step because the input is what you have just
 * been ticking — moving it elsewhere would hide the fact that approving is what decides the
 * contents. Rebuilding after approving more frames simply replaces the previous file.
 */
function TimelapsePanel({
  approvedCount,
  fps,
  timelapse,
  encoding,
  busy,
  onBuild,
  onOpen
}: {
  approvedCount: number
  fps: number
  timelapse: Artifact | null
  encoding: { done: number; total: number } | null
  busy: boolean
  onBuild: () => void
  onOpen: (path: string) => void
}) {
  const tooFew = approvedCount < 2
  // Encoding is real-time, so the length of the video is also the length of the wait.
  // Saying so up front beats a button that looks frozen for half a minute.
  const seconds = Math.max(1, Math.round(approvedCount / Math.max(1, fps)))

  return (
    <div className="rounded-[12px] border border-border bg-bg p-5">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-text-dim">
              <FilmIcon size={15} />
            </span>
            <h3 className="text-[15px] font-semibold">Timelapse</h3>
          </div>
          <p className="max-w-lg text-[13px] leading-relaxed text-text-dim">
            {tooFew
              ? 'Approve at least two screenshots above and this becomes available. The video is built from approved frames only — the same rule the report follows.'
              : `Built from the ${approvedCount} approved frame${approvedCount === 1 ? '' : 's'} above, in order — about ${seconds} second${seconds === 1 ? '' : 's'} of video at ${fps} fps. Encoding runs in real time, so it takes about that long too.`}
          </p>
        </div>

        <Button
          variant="secondary"
          size="sm"
          icon={<FilmIcon size={14} />}
          disabled={tooFew || busy}
          onClick={onBuild}
        >
          {timelapse ? 'Rebuild' : 'Build timelapse'}
        </Button>
      </div>

      {encoding && (
        <div className="mt-4">
          <div className="h-1.5 overflow-hidden rounded-full bg-card">
            <div
              className="h-full bg-accent transition-[width] duration-200"
              style={{ width: `${Math.round((encoding.done / Math.max(1, encoding.total)) * 100)}%` }}
            />
          </div>
          <p className="mt-2 font-mono text-[12px] text-text-faint">
            Encoding frame {encoding.done} of {encoding.total}…
          </p>
        </div>
      )}

      {timelapse && !encoding && (
        <div className="mt-4 flex items-center justify-between rounded-[10px] border border-accent/30 bg-accent/5 px-4 py-3">
          <span className="min-w-0 flex-1 truncate text-[13px] text-text">
            Ready — {timelapse.path.split(/[\\/]/).pop()}
          </span>
          <Button variant="ghost" size="sm" onClick={() => onOpen(timelapse.path)}>
            Play
          </Button>
        </div>
      )}
    </div>
  )
}

function SummaryBox({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <div className="rounded-[12px] border border-border bg-bg p-5">
      <h3 className="mb-4 text-[15px] font-semibold">Write your daily summary</h3>
      <textarea
        value={value}
        maxLength={SUMMARY_MAX}
        onChange={(event) => onChange(event.target.value)}
        rows={7}
        placeholder="What did you work on, what went well, what is next?"
        className="w-full resize-none rounded-[10px] border border-accent/60 bg-card p-4 text-[14px]
          leading-relaxed text-text outline-none placeholder:text-text-faint focus:border-accent"
      />
      <p className="mt-2 text-right text-[12px] text-text-faint">
        {value.length} / {SUMMARY_MAX} characters
      </p>
    </div>
  )
}

function PublishPreview({
  date,
  review,
  flags,
  includedCount,
  publishedAt,
  onUnpublish
}: {
  date: string
  review: DayReview
  flags: PublishFlags
  includedCount: number
  publishedAt: number | null
  onUnpublish: () => Promise<void>
}) {
  const lines: string[] = []
  if (flags.sessions) lines.push(`Time tracking — ${formatDuration(review.trackedMin)} across ${review.sessionCount} sessions`)
  if (flags.tasks) lines.push(`Tasks — ${review.completedTasks} completed of ${review.totalTasks} worked on`)
  if (flags.summary) lines.push('Daily summary text')
  if (flags.screenshots) lines.push(`${includedCount} approved screenshot${includedCount === 1 ? '' : 's'}`)
  if (flags.timelapse && review.hasTimelapse) lines.push('Timelapse video')

  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-[12px] border border-border bg-bg p-5">
        <div className="mb-3 flex items-center gap-2 text-accent">
          <ShieldIcon size={15} />
          <h3 className="text-[15px] font-semibold text-text">About to be published — {date}</h3>
        </div>

        {lines.length === 0 ? (
          <p className="text-[13px] text-text-faint">
            Nothing selected. Go back and tick at least one category.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {lines.map((line) => (
              <li key={line} className="flex items-center gap-2.5 text-[14px] text-text">
                <span className="text-accent">
                  <CheckIcon size={14} />
                </span>
                {line}
              </li>
            ))}
          </ul>
        )}

        <p className="mt-4 border-t border-border pt-4 text-[13px] leading-relaxed text-text-dim">
          Your supervisor reaches this through a login page — the link alone is not enough. You can
          revoke the whole day at any time, which deletes the published copies.
        </p>
      </div>

      {publishedAt && (
        <div className="flex items-center justify-between rounded-[12px] border border-accent/30 bg-accent/5 p-5">
          <div className="text-[14px]">
            <div className="font-medium text-accent">Published</div>
            <div className="mt-0.5 text-[13px] text-text-dim">
              {formatLongDate(publishedAt)} — visible to your supervisor.
            </div>
          </div>
          <Button variant="danger" onClick={() => void onUnpublish()}>
            Unpublish
          </Button>
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ helpers

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
