import { useEffect, useMemo, useState } from 'react'
import type {
  Area,
  CalendarEvent,
  ClassificationSuggestion,
  Project,
  RegistrationMode,
  WorkType
} from '@core/contract/types.js'
import { api } from '../../api/client.js'
import { Button } from '../../ui/Button.js'
import { Modal } from '../../ui/Modal.js'
import { DateField } from '../../ui/DateField.js'
import { TimeField } from '../../ui/TimeField.js'
import { Toggle } from '../settings/SettingsSection.js'
import { formatDuration } from '../../lib/format.js'

const MINUTE = 60_000
const TRAVEL_CHOICES = [0, 15, 30, 45, 60, 90]

const pad = (n: number): string => String(n).padStart(2, '0')

const isoDateOf = (ms: number): string => {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const minuteOf = (ms: number): number => {
  const date = new Date(ms)
  return date.getHours() * 60 + date.getMinutes()
}

/** Local midnight on `date` plus a minute offset — the inverse of the two above. */
const momentAt = (date: string, minute: number): number => {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year!, (month ?? 1) - 1, day ?? 1, 0, 0, 0, 0).getTime() + minute * MINUTE
}

/**
 * Deciding what an imported appointment is.
 *
 * Everything here is the app's existing vocabulary — the same Area buttons as the task
 * editor, the same projects and work types — because a calendar event classified in a
 * private language would report separately from everything else.
 *
 * Three things it is careful about:
 *   - **who owns the times.** For an imported event they belong to the calendar, so they are
 *     shown and not edited: the next sync would overwrite an edit and the loss would be
 *     silent. An event Uurwerk created has no such publisher, so those times are editable
 *     here — and moving them drags the travel blocks along, which is the whole reason travel
 *     is modelled as events
 *   - **hours are opt-in**. An imported meeting is not automatically an hour on your
 *     internship, so the registration starts at "do not count" and you say otherwise
 *   - **travel is real time**. It blocks the calendar whether or not it is paid, and whether
 *     it counts toward worked hours is a separate question with its own answer
 *
 * It reopens on an already-classified event too, which is what makes a decision reversible:
 * a meeting filed under the wrong area used to be filed there for good.
 */
export function EventClassifier({
  event,
  suggestion,
  areas,
  projects,
  workTypes,
  travel,
  sourceName,
  onDone,
  onClose
}: {
  event: CalendarEvent
  suggestion: ClassificationSuggestion | null
  areas: Area[]
  projects: Project[]
  workTypes: WorkType[]
  /**
   * Every travel block in view, so reopening an event can show the journey it already has.
   * Filtered by parent here rather than by the caller — the caller has the whole week.
   */
  travel: CalendarEvent[]
  /** The calendar it came from, for the source card. */
  sourceName: string
  onDone: () => void
  onClose: () => void
}) {
  const [areaId, setAreaId] = useState<string | null>(null)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [workTypeId, setWorkTypeId] = useState<string | null>(null)
  const [includeInPlanning, setIncludeInPlanning] = useState(true)
  const [registrationMode, setRegistrationMode] = useState<RegistrationMode>('none')
  const [travelOn, setTravelOn] = useState(false)
  const [outboundMin, setOutboundMin] = useState(30)
  const [returnMin, setReturnMin] = useState(30)
  const [travelCounts, setTravelCounts] = useState(true)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  /** Only an event Uurwerk owns can be moved; a subscription would overwrite the change. */
  const movable = event.origin === 'uurwerk'
  /** Reopened rather than newly arrived, which changes what the dialog is claiming to be. */
  const classified = event.classificationStatus === 'confirmed'
  const [date, setDate] = useState(() => isoDateOf(event.startsAt))
  const [startMin, setStartMin] = useState(() => minuteOf(event.startsAt))
  const [endMin, setEndMin] = useState(() => minuteOf(event.endsAt))

  // The suggestion arrives pre-selected — that is the whole point of a suggestion — and
  // every field stays changeable.
  useEffect(() => {
    setAreaId(suggestion?.areaId ?? event.areaId)
    setProjectId(suggestion?.projectId ?? event.projectId)
    setWorkTypeId(suggestion?.workTypeId ?? event.workTypeId)
    setIncludeInPlanning(event.includeInPlanning)
    setRegistrationMode(event.registrationMode)
    setDate(isoDateOf(event.startsAt))
    setStartMin(minuteOf(event.startsAt))
    setEndMin(minuteOf(event.endsAt))

    // Reopening an event that already has travel has to show that travel, or saving would
    // read as "no journey" and silently delete the blocks.
    const existingTravel = travel.filter((block) => block.parentEventId === event.id)
    const outbound = existingTravel.find((block) => block.travelDirection === 'outbound')
    const back = existingTravel.find((block) => block.travelDirection === 'return')
    setTravelOn(existingTravel.length > 0)
    if (outbound) setOutboundMin(Math.round((outbound.endsAt - outbound.startsAt) / MINUTE))
    if (back) setReturnMin(Math.round((back.endsAt - back.startsAt) / MINUTE))
    if (existingTravel.length > 0) {
      setTravelCounts(existingTravel.some((block) => block.countsAsWorked))
    }
  }, [event, suggestion, travel])

  const area = areas.find((entry) => entry.id === areaId) ?? null
  const durationMin = movable
    ? Math.max(0, endMin - startMin)
    : Math.round((event.endsAt - event.startsAt) / MINUTE)

  /** What would be registered, so the number is visible before it is agreed to. */
  const registrableMin = useMemo(() => {
    const own = registrationMode === 'none' ? 0 : durationMin
    const journey = travelOn && travelCounts ? outboundMin + returnMin : 0
    return own + journey
  }, [registrationMode, durationMin, travelOn, travelCounts, outboundMin, returnMin])

  const save = async (remember: boolean): Promise<void> => {
    if (movable && endMin <= startMin) {
      setProblem('An appointment has to end after it starts.')
      return
    }

    setBusy(true)
    setProblem(null)
    try {
      // Times first, classification second. Moving rewrites the hours this event registers,
      // so doing it the other way round would register them at the old time and leave them
      // there.
      if (movable) {
        const nextStart = momentAt(date, startMin)
        const nextEnd = momentAt(date, endMin)
        if (nextStart !== event.startsAt || nextEnd !== event.endsAt) {
          await api.calendar.move(event.id, nextStart, nextEnd)
        }
      }

      await api.calendar.classify(event.id, {
        areaId,
        organizationId:
          suggestion?.organizationId ??
          projects.find((project) => project.id === projectId)?.organizationId ??
          null,
        projectId,
        workTypeId,
        remember,
        includeInPlanning,
        registrationMode,
        countsAsWorked: registrationMode !== 'none',
        ...(travelOn && (outboundMin > 0 || returnMin > 0)
          ? { travel: { outboundMin, returnMin, countsAsWorked: travelCounts } }
          : {})
      })
      onDone()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const skip = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.calendar.ignore(event.id)
      onDone()
    } finally {
      setBusy(false)
    }
  }

  const field =
    'w-full rounded-[10px] border border-border bg-bg px-3.5 py-2.5 text-[14px] text-text outline-none focus:border-accent'
  const readOnly =
    'w-full rounded-[10px] border border-border bg-card px-3.5 py-2.5 text-[14px] text-text-dim'

  return (
    <Modal
      open
      onClose={onClose}
      width={1020}
      title={classified ? 'Edit calendar event' : 'New calendar event'}
      subtitle={
        classified
          ? 'Already filed. Change anything here and it is refiled, hours included.'
          : movable
            ? 'Your own appointment. Say what it is and whether it counts.'
            : 'A new event was found in your connected calendar.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => void skip()} disabled={busy}>
            {/* Same call either way: it stops being filed and stops counting. */}
            {classified ? 'Unfile' : 'Skip'}
          </Button>
          <div className="flex gap-3">
            <Button variant="secondary" onClick={() => void save(false)} disabled={busy}>
              Only once
            </Button>
            {/* The difference is the only thing that matters here: this one writes rules. */}
            <Button variant="primary" onClick={() => void save(true)} disabled={busy}>
              Save label
            </Button>
          </div>
        </>
      }
    >
      {problem && (
        <div className="mb-5 rounded-[10px] border border-prio-med/40 bg-prio-med/10 px-4 py-3 text-[13px] text-prio-med">
          {problem}
        </div>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)_320px] gap-6">
        {/* ------------------------------------------------------------ left */}
        <div className="flex flex-col gap-5">
          <div className="rounded-[12px] border border-border bg-bg px-4 py-3">
            <div className="text-[13px] text-text">
              From: <span className="font-medium">{movable ? 'Uurwerk' : sourceName}</span>
            </div>
            <div className="mt-0.5 text-[12px] text-text-dim">
              {movable
                ? 'Created here · yours to change'
                : 'Imported automatically · read-only subscription'}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-[13px] text-text-dim">Title</span>
            <div className={readOnly}>{event.title}</div>
            {!movable && (
              <span className="text-[12px] text-text-faint">
                The title and times come from your calendar, so changing them here would be undone
                by the next sync.
              </span>
            )}
          </div>

          {movable ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                <span className="text-[13px] text-text-dim">Day</span>
                <DateField value={date} onChange={setDate} />
              </div>
              <div className="flex items-end gap-4">
                <div className="flex flex-col gap-2">
                  <span className="text-[13px] text-text-dim">From</span>
                  <TimeField value={startMin} onChange={setStartMin} />
                </div>
                <div className="flex flex-col gap-2">
                  <span className="text-[13px] text-text-dim">To</span>
                  <TimeField value={endMin} onChange={setEndMin} allowEndOfDay />
                </div>
                <div className="flex flex-col gap-2">
                  <span className="text-[13px] text-text-dim">Length</span>
                  <div className="rounded-[8px] border border-border bg-card px-2.5 py-1.5 font-mono text-[13px] text-text">
                    {formatDuration(durationMin)}
                  </div>
                </div>
              </div>
              <span className="text-[12px] text-text-faint">
                This appointment is yours, so you can move it. Travel blocks move with it.
              </span>
            </div>
          ) : (
            <div className="grid grid-cols-[1fr_1fr_auto] gap-4">
              <div className="flex flex-col gap-2">
                <span className="text-[13px] text-text-dim">Start</span>
                <div className={readOnly}>{formatMoment(event.startsAt)}</div>
              </div>
              <div className="flex flex-col gap-2">
                <span className="text-[13px] text-text-dim">End</span>
                <div className={readOnly}>{formatMoment(event.endsAt)}</div>
              </div>
              <div className="flex flex-col gap-2">
                <span className="text-[13px] text-text-dim">Length</span>
                <div className={`${readOnly} font-mono whitespace-nowrap`}>
                  {formatDuration(durationMin)}
                </div>
              </div>
            </div>
          )}

          {suggestion && suggestion.confidence > 0 && (
            <div className="rounded-[12px] border border-accent/30 bg-rail-active p-4">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[13px] font-medium text-text">
                  Suggested based on earlier events
                </span>
                <span className="shrink-0 text-[13px] text-accent">
                  {suggestion.confidence}% match
                </span>
              </div>
              {suggestion.reasons.length > 0 && (
                <ul className="mt-2 flex flex-col gap-1">
                  {suggestion.reasons.map((reason) => (
                    <li key={reason} className="text-[12px] text-text-dim">
                      {reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="flex flex-col gap-2">
            <span className="text-[13px] text-text-dim">Area</span>
            <div className="flex gap-2">
              {areas.map((entry) => (
                <button
                  key={entry.id}
                  onClick={() => setAreaId(entry.id)}
                  className={`flex-1 rounded-[10px] border py-2.5 text-[13px] transition-colors ${
                    areaId === entry.id
                      ? 'border-accent/50 bg-rail-active text-text'
                      : 'border-border bg-bg text-text-dim hover:bg-card-hover'
                  }`}
                >
                  {entry.name}
                </button>
              ))}
            </div>
            <span className="text-[12px] text-text-faint">
              {area?.countsAsStageHours
                ? 'This event counts toward your internship hours.'
                : 'Time on this event is tracked, but does not count toward internship hours.'}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <label className="flex flex-col gap-2">
              <span className="text-[13px] text-text-dim">Project</span>
              <select
                value={projectId ?? ''}
                onChange={(event_) => setProjectId(event_.target.value || null)}
                className={field}
              >
                <option value="">No project</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
              <span className="text-[12px] text-text-faint">
                The project decides who the work is for. It does not decide the area.
              </span>
            </label>

            <label className="flex flex-col gap-2">
              <span className="text-[13px] text-text-dim">Work type</span>
              <select
                value={workTypeId ?? ''}
                onChange={(event_) => setWorkTypeId(event_.target.value || null)}
                className={field}
              >
                <option value="">Unlabelled</option>
                {workTypes.map((workType) => (
                  <option key={workType.id} value={workType.id}>
                    {workType.name}
                  </option>
                ))}
              </select>
              <span className="text-[12px] text-text-faint">
                What kind of activity this is, across every area.
              </span>
            </label>
          </div>

          <div className="rounded-[12px] border border-border bg-bg p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[14px] text-text">Add to Uurwerk planning</div>
                <div className="mt-0.5 text-[12px] text-text-dim">
                  Blocks this time, so the planner does not schedule work on top of it.
                </div>
              </div>
              <Toggle checked={includeInPlanning} onChange={setIncludeInPlanning} />
            </div>
          </div>
        </div>

        {/* ----------------------------------------------------------- right */}
        <div className="flex flex-col gap-5">
          <section className="rounded-[12px] border border-border bg-bg p-4">
            <h3 className="mb-3 text-[14px] font-semibold">Hours to register</h3>

            <dl className="flex flex-col gap-2 text-[13px]">
              <Row label="Event duration" value={formatDuration(durationMin)} muted={registrationMode === 'none'} />
              {travelOn && (
                <>
                  <Row label="Travel there" value={formatDuration(outboundMin)} muted={!travelCounts} />
                  <Row label="Travel back" value={formatDuration(returnMin)} muted={!travelCounts} />
                </>
              )}
              <div className="mt-1 flex items-center justify-between border-t border-border pt-2">
                <dt className="text-text">Counted as worked</dt>
                <dd className="font-mono text-text">{formatDuration(registrableMin)}</dd>
              </div>
            </dl>

            <div className="mt-3 flex flex-col gap-1.5">
              {(
                [
                  ['none', 'Do not count as worked time'],
                  ['calendar', 'Use the calendar duration'],
                  ['confirm', 'Ask me afterwards what it really was']
                ] as Array<[RegistrationMode, string]>
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  onClick={() => setRegistrationMode(mode)}
                  className={`rounded-[8px] border px-3 py-2 text-left text-[12px] transition-colors ${
                    registrationMode === mode
                      ? 'border-accent/50 bg-rail-active text-text'
                      : 'border-border text-text-dim hover:text-text'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </section>

          <section className="rounded-[12px] border border-border bg-bg p-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="text-[14px] font-semibold">Travel time</h3>
              <Toggle checked={travelOn} onChange={setTravelOn} />
            </div>

            {travelOn ? (
              <>
                <div className="flex flex-col gap-2">
                  <TravelRow label="To location" value={outboundMin} onChange={setOutboundMin} />
                  <TravelRow label="Back" value={returnMin} onChange={setReturnMin} />
                </div>

                <label className="mt-3 flex items-center gap-2 text-[12px] text-text-dim">
                  <input
                    type="checkbox"
                    checked={travelCounts}
                    onChange={(event_) => setTravelCounts(event_.target.checked)}
                    className="accent-accent"
                  />
                  Travel counts toward worked hours
                </label>

                <p className="mt-2 text-[12px] leading-relaxed text-text-faint">
                  Travel is added as its own blocks either side of the appointment, so it shows in
                  your week and blocks planning even when it is not paid.
                </p>
              </>
            ) : (
              <p className="text-[12px] leading-relaxed text-text-dim">
                No journey. Turn this on for an appointment you have to travel to.
              </p>
            )}
          </section>

          <section className="rounded-[12px] border border-border bg-bg p-4">
            <h3 className="mb-1 text-[14px] font-semibold">Classification</h3>
            <p className="text-[12px] leading-relaxed text-text-dim">
              <strong className="text-text">Save label</strong> remembers this for events like it,
              so the same weekly meeting stops asking. <strong className="text-text">Only once</strong>{' '}
              applies it here and learns nothing.
            </p>
          </section>
        </div>
      </div>
    </Modal>
  )
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <dt className={muted ? 'text-text-faint line-through' : 'text-text-dim'}>{label}</dt>
      <dd className={`font-mono ${muted ? 'text-text-faint line-through' : 'text-text-dim'}`}>
        {value}
      </dd>
    </div>
  )
}

function TravelRow({
  label,
  value,
  onChange
}: {
  label: string
  value: number
  onChange: (minutes: number) => void
}) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="text-[13px] text-text-dim">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="rounded-[8px] border border-border bg-card px-2.5 py-1.5 text-[13px] text-text outline-none focus:border-accent"
      >
        {TRAVEL_CHOICES.map((minutes) => (
          <option key={minutes} value={minutes}>
            {minutes === 0 ? 'None' : formatDuration(minutes)}
          </option>
        ))}
      </select>
    </label>
  )
}

/** "Tue 18 Aug · 09:00" — the shape from the mockup. */
function formatMoment(at: number): string {
  const date = new Date(at)
  const day = date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return `${day} · ${time}`
}
