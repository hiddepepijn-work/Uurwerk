import { useState } from 'react'
import type { CalendarEvent } from '@core/contract/types.js'
import { api } from '../../api/client.js'
import { Button } from '../../ui/Button.js'
import { Modal } from '../../ui/Modal.js'
import { DateField } from '../../ui/DateField.js'
import { TimeField } from '../../ui/TimeField.js'
import { formatDuration } from '../../lib/format.js'

const MINUTE = 60_000

const AREAS = [
  { id: 'stage', label: 'Stage' },
  { id: 'work', label: 'Work' },
  { id: 'school', label: 'School' },
  { id: 'personal', label: 'Private' }
]

const TRAVEL_OPTIONS = [0, 15, 30, 45, 60]

const formatClock = (minute: number): string => {
  const m = ((minute % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

const at = (date: string, minute: number): number => {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year!, (month ?? 1) - 1, day ?? 1, 0, 0, 0, 0).getTime() + minute * MINUTE
}

/**
 * An appointment of your own.
 *
 * `calendar.createEvent` has been on the seam since the calendar landed with nothing calling
 * it, which meant appointments could only ever arrive from a subscription — and every
 * subscription this app can talk to is read-only. So an hour you agreed to by email, or a
 * supervisor meeting arranged in a corridor, had nowhere to go.
 *
 * One question from the classifier is asked here after all: how long the journey is.
 * Leaving on time is what the reminders are for ("verzamel je spullen" 30 minutes before
 * leaving, a spoken "lukt het?" at 15), and they can only count back from a departure the
 * calendar knows. Travel needs an area to inherit, so giving a travel time asks for one too;
 * the rest — hours, rules — stays the classifier's.
 */
export function EventComposer({
  initialDate,
  onCreated,
  onClose
}: {
  /** The day that was clicked, so the common case needs no date picking. */
  initialDate: string
  /** Handed the new event so the caller can go straight on to classifying it. */
  onCreated: (event: CalendarEvent) => void
  onClose: () => void
}) {
  const [title, setTitle] = useState('')
  const [location, setLocation] = useState('')
  const [date, setDate] = useState(initialDate)
  const [startMin, setStartMin] = useState(10 * 60)
  const [endMin, setEndMin] = useState(11 * 60)
  const [areaId, setAreaId] = useState<string | null>(null)
  const [notes, setNotes] = useState('')
  const [travelMin, setTravelMin] = useState(0)
  const [travelBack, setTravelBack] = useState(true)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const durationMin = endMin - startMin

  const create = async (): Promise<void> => {
    if (!title.trim()) return
    if (endMin <= startMin) {
      setProblem('An appointment has to end after it starts.')
      return
    }
    if (travelMin > 0 && !areaId) {
      setProblem('Pick what this is for, so the journey knows where its time belongs.')
      return
    }

    setBusy(true)
    setProblem(null)
    try {
      const created = await api.calendar.createEvent({
        title: title.trim(),
        location: location.trim() || null,
        description: notes.trim() || null,
        startsAt: at(date, startMin),
        endsAt: at(date, endMin),
        // Ours, not a provider's: this is what lets the classifier let you edit the times
        // later, where an imported event's times belong to whoever published them.
        origin: 'uurwerk',
        classificationStatus: 'unclassified',
        includeInPlanning: true,
        // Nothing counts as worked until you say so, exactly as with an imported event.
        registrationMode: 'none',
        countsAsWorked: false
      })
      if (areaId) {
        const classified = await api.calendar.classify(created.id, {
          areaId,
          organizationId: null,
          projectId: null,
          workTypeId: null,
          remember: false,
          includeInPlanning: true,
          registrationMode: 'none',
          countsAsWorked: false,
          ...(travelMin > 0
            ? { travel: { outboundMin: travelMin, returnMin: travelBack ? travelMin : 0, countsAsWorked: false } }
            : {})
        })
        onCreated(classified)
      } else onCreated(created)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const field =
    'w-full rounded-[10px] border border-border bg-bg px-3.5 py-2.5 text-[14px] text-text outline-none placeholder:text-text-faint focus:border-accent'

  return (
    <Modal
      open
      onClose={onClose}
      width={560}
      title="New appointment"
      subtitle="Yours, in Uurwerk. Subscribed calendars are read-only, so this never leaves the app."
      footer={
        <>
          <span className="text-[13px] text-text-dim">
            {durationMin > 0 ? formatDuration(durationMin) : 'Ends before it starts'}
          </span>
          <div className="flex gap-3">
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void create()}
              disabled={busy || !title.trim() || durationMin <= 0}
            >
              Create and classify
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

      <div className="flex flex-col gap-5">
        <label className="flex flex-col gap-2">
          <span className="text-[13px] text-text-dim">Title</span>
          <input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && void create()}
            placeholder="Projectoverleg Maasarend"
            className={field}
          />
        </label>

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
        </div>

        <label className="flex flex-col gap-2">
          <span className="text-[13px] text-text-dim">Location</span>
          <input
            value={location}
            onChange={(event) => setLocation(event.target.value)}
            placeholder="Optional"
            className={field}
          />
          <span className="text-[12px] text-text-faint">
            Used when guessing what this is, alongside the title.
          </span>
        </label>

        <label className="flex flex-col gap-2">
          <span className="text-[13px] text-text-dim">Notes</span>
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={3}
            placeholder="What to bring or prepare, who is there, particulars"
            className={`${field} resize-y`}
          />
        </label>

        <div className="flex flex-col gap-2">
          <span className="text-[13px] text-text-dim">For</span>
          <div className="flex flex-wrap gap-2">
            {AREAS.map((area) => (
              <button
                key={area.id}
                type="button"
                onClick={() => setAreaId(areaId === area.id ? null : area.id)}
                className={`h-10 rounded-full border px-4 text-[14px] ${
                  areaId === area.id ? 'border-accent bg-rail-active text-accent' : 'border-border text-text-dim'
                }`}
              >
                {area.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-[13px] text-text-dim">Travel time</span>
          <div className="flex flex-wrap items-center gap-2">
            {TRAVEL_OPTIONS.map((minutes) => (
              <button
                key={minutes}
                type="button"
                onClick={() => setTravelMin(minutes)}
                className={`h-10 min-w-12 rounded-full border px-3 text-[14px] ${
                  travelMin === minutes ? 'border-accent bg-rail-active text-accent' : 'border-border text-text-dim'
                }`}
              >
                {minutes === 0 ? 'None' : `${minutes} min`}
              </button>
            ))}
            <input
              type="number"
              min={0}
              max={600}
              aria-label="Travel time in minutes"
              value={travelMin || ''}
              onChange={(event) => setTravelMin(Math.max(0, Number(event.target.value) || 0))}
              placeholder="min"
              className="h-10 w-20 rounded-full border border-border bg-bg px-3 text-[14px] text-text outline-none focus:border-accent"
            />
          </div>
          {travelMin > 0 && (
            <label className="flex items-center gap-2 text-[13px] text-text-dim">
              <input type="checkbox" checked={travelBack} onChange={(event) => setTravelBack(event.target.checked)} />
              Same journey back afterwards
            </label>
          )}
          {travelMin > 0 && durationMin > 0 && (
            <span className="text-[13px] text-accent">
              Leave at {formatClock(startMin - travelMin)} — reminders at {formatClock(startMin - travelMin - 30)} and {formatClock(startMin - travelMin - 15)}.
            </span>
          )}
        </div>
      </div>
    </Modal>
  )
}
