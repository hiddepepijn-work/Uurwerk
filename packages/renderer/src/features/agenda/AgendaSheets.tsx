import { useEffect, useMemo, useState } from 'react'

import type { CalendarEvent, IsoDate, Task } from '@core/contract/types.js'
import { fromIsoDate } from '@core/util/time.js'

import { api } from '../../api/client.js'
import { Modal } from '../../ui/Modal.js'
import { EventComposer } from '../calendar/EventComposer.js'
import { placeTask } from './actions.js'
import { AREA_COLORS, colorFor, hhmm, type AgendaItem } from './agenda-model.js'

/**
 * The agenda's two sheets: what to put at an empty moment, and what an item is.
 */

const dayLabel = (date: IsoDate): string =>
  fromIsoDate(date).toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' })

const DURATIONS = [30, 60, 90, 120]
const AREAS = ['stage', 'school', 'personal', 'work'] as const

const chip = (active: boolean): string =>
  `h-10 rounded-full px-4 text-[14px] font-medium transition-colors ${
    active ? 'bg-accent text-bg' : 'bg-bg text-text-dim hover:text-text'
  }`

// --------------------------------------------------------------- empty slot

type SlotMode = 'new' | 'existing' | 'appointment'

/** Tapped an empty moment: a new task there, an existing one, or an appointment. */
export function SlotSheet({ date, minute, onClose }: { date: IsoDate; minute: number; onClose: () => void }) {
  const [mode, setMode] = useState<SlotMode>('new')
  const [title, setTitle] = useState('')
  const [duration, setDuration] = useState(60)
  const [area, setArea] = useState<(typeof AREAS)[number]>('personal')
  const [search, setSearch] = useState('')
  const [tasks, setTasks] = useState<Task[]>([])
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    if (mode === 'existing') void api.tasks.list({ status: 'active' }).then(setTasks)
  }, [mode])

  const shown = useMemo(() => {
    const wanted = search.trim().toLowerCase()
    return tasks.filter((task) => !wanted || task.title.toLowerCase().includes(wanted)).slice(0, 30)
  }, [tasks, search])

  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      await work()
      onClose()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const createTask = (): Promise<void> =>
    run(async () => {
      if (!title.trim()) throw new Error('Geef de taak een naam.')
      const task = await api.tasks.create({ title: title.trim(), areaId: area, estimateMin: duration })
      await placeTask(task.id, date, minute, Math.min(24 * 60, minute + duration))
    })

  const planExisting = (task: Task): Promise<void> =>
    run(async () => {
      // Its estimate, within reason; a long task gets a first stretch of two hours.
      const length = Math.min(Math.max(task.estimateMin ?? 60, 15), 120)
      await placeTask(task.id, date, minute, Math.min(24 * 60, minute + length))
    })

  if (mode === 'appointment') {
    return <EventComposer initialDate={date} initialStartMin={minute} onCreated={onClose} onClose={onClose} />
  }

  return (
    <Modal open title={`${hhmm(minute)} · ${dayLabel(date)}`} subtitle="Wat komt hier?" onClose={onClose} width={520}>
      <div className="flex flex-col gap-4 px-4 py-4 wide:px-7">
        <div className="flex rounded-[12px] bg-bg p-1">
          {(
            [
              ['new', 'Nieuwe taak'],
              ['existing', 'Bestaande taak'],
              ['appointment', 'Afspraak']
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              onClick={() => setMode(value)}
              className={`h-10 flex-1 rounded-[9px] text-[14px] font-medium ${
                mode === value ? 'bg-rail-active text-accent' : 'text-text-dim'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {problem && (
          <div className="rounded-[10px] border border-prio-med/40 bg-prio-med/10 px-3.5 py-2.5 text-[13px] text-prio-med">
            {problem}
          </div>
        )}

        {mode === 'new' && (
          <>
            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && void createTask()}
              placeholder="Wat ga je doen?"
              aria-label="Naam van de taak"
              className="h-12 rounded-[12px] border border-border bg-bg px-4 text-[16px] text-text outline-none placeholder:text-text-faint focus:border-accent"
            />
            <div className="flex flex-wrap gap-2">
              {DURATIONS.map((minutes) => (
                <button key={minutes} onClick={() => setDuration(minutes)} className={chip(duration === minutes)}>
                  {minutes < 60 ? `${minutes} min` : `${minutes / 60} uur`.replace('.5', ',5')}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              {AREAS.map((value) => (
                <button
                  key={value}
                  onClick={() => setArea(value)}
                  className="flex h-10 items-center gap-2 rounded-full px-4 text-[14px] font-medium"
                  style={{
                    background: area === value ? `${AREA_COLORS[value]!.fill}33` : 'var(--color-bg)',
                    color: area === value ? AREA_COLORS[value]!.fill : 'var(--color-text-dim)'
                  }}
                >
                  <span className="h-2 w-2 rounded-full" style={{ background: AREA_COLORS[value]!.fill }} />
                  {AREA_COLORS[value]!.label}
                </button>
              ))}
            </div>
            <button
              onClick={() => void createTask()}
              disabled={busy || !title.trim()}
              className="h-12 rounded-full bg-accent text-[15px] font-semibold text-bg disabled:opacity-40"
            >
              Inplannen om {hhmm(minute)}–{hhmm(Math.min(24 * 60, minute + duration))}
            </button>
          </>
        )}

        {mode === 'existing' && (
          <>
            <input
              autoFocus
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Zoek een taak"
              aria-label="Zoek een taak"
              className="h-12 rounded-[12px] border border-border bg-bg px-4 text-[16px] text-text outline-none placeholder:text-text-faint focus:border-accent"
            />
            <div className="flex max-h-[46vh] flex-col gap-1.5 overflow-y-auto">
              {shown.map((task) => (
                <button
                  key={task.id}
                  disabled={busy}
                  onClick={() => void planExisting(task)}
                  className="flex items-center gap-3 rounded-[12px] bg-bg px-3.5 py-3 text-left hover:bg-card-hover"
                >
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: colorFor(task.areaId).fill }} />
                  <span className="min-w-0 flex-1 truncate text-[15px] text-text">{task.title}</span>
                  <span className="shrink-0 text-[12px] text-text-dim">
                    {task.estimateMin ? `${Math.min(task.estimateMin, 120)} min` : '1 uur'}
                  </span>
                </button>
              ))}
              {shown.length === 0 && <p className="py-6 text-center text-[14px] text-text-dim">Geen open taken gevonden.</p>}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

// --------------------------------------------------------------------- item

/** Tapped an item: what it is, and what you can do with it. */
export function ItemSheet({ item, onClose }: { item: AgendaItem; onClose: () => void }) {
  const [task, setTask] = useState<Task | null>(null)
  const [event, setEvent] = useState<CalendarEvent | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    const source = item.source
    if (source.type === 'block') {
      if (source.taskId) void api.tasks.get(source.taskId).then(setTask)
      return
    }
    // An appointment, or the travel belonging to one: show the appointment.
    const midnight = fromIsoDate(item.date).getTime()
    void api.calendar.eventsInRange(midnight - 86_400_000, midnight + 2 * 86_400_000).then((events) => {
      const wanted = source.parentId ?? source.eventId
      setEvent(events.find((entry) => entry.id === wanted) ?? null)
    })
  }, [item])

  const run = async (work: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      await work()
      onClose()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const source = item.source
  const color = colorFor(item.areaId)
  const clock = (ms: number): string => {
    const d = new Date(ms)
    return hhmm(d.getHours() * 60 + d.getMinutes())
  }
  const rows: Array<[string, string]> = []
  if (source.type === 'block') {
    rows.push(['Wanneer', `${hhmm(item.startMin)}–${hhmm(item.endMin)}, ${dayLabel(item.date)}`])
    rows.push(['Gebied', color.label])
    if (task?.projectName) rows.push(['Project', task.projectName])
    if (task?.estimateMin) rows.push(['Schatting', `${task.estimateMin} min, ${task.loggedMin ?? 0} min gewerkt`])
    if (task?.dueDate) rows.push(['Deadline', dayLabel(task.dueDate)])
  } else if (event) {
    rows.push(['Wanneer', `${clock(event.startsAt)}–${clock(event.endsAt)}, ${dayLabel(item.date)}`])
    if (event.location) rows.push(['Waar', event.location])
    rows.push(['Gebied', colorFor(event.areaId).label])
    if (source.parentId) rows.push(['Reis', item.title])
  }
  const notes = source.type === 'block' ? task?.notes : event?.description

  const title = source.type === 'block' ? (task?.title ?? item.title) : (event?.title ?? item.title)
  const kind = source.type === 'block' ? 'Taak in de planning' : source.parentId ? 'Reis voor een afspraak' : 'Afspraak'

  return (
    <Modal open title={title} subtitle={kind} onClose={onClose} width={520}>
      <div className="flex flex-col gap-4 px-4 py-4 wide:px-7">
        <div className="flex flex-col gap-2">
          {rows.map(([label, value]) => (
            <div key={label} className="flex gap-3 text-[14px]">
              <span className="w-24 shrink-0 text-text-dim">{label}</span>
              <span className="text-text">{value}</span>
            </div>
          ))}
        </div>

        {notes && (
          <div className="rounded-[12px] bg-bg px-3.5 py-3 text-[14px] leading-relaxed whitespace-pre-wrap text-text">{notes}</div>
        )}

        {problem && (
          <div className="rounded-[10px] border border-prio-med/40 bg-prio-med/10 px-3.5 py-2.5 text-[13px] text-prio-med">
            {problem}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {source.type === 'block' && source.taskId && (
            <>
              <button
                disabled={busy}
                onClick={() => void run(() => api.tracking.startRun(source.taskId))}
                className="h-11 rounded-full bg-accent px-5 text-[14px] font-semibold text-bg"
              >
                Timer starten
              </button>
              <button
                disabled={busy}
                onClick={() => void run(() => api.tasks.complete(source.taskId!, true))}
                className="h-11 rounded-full bg-bg px-5 text-[14px] font-medium text-text"
              >
                Afgerond
              </button>
              <button
                disabled={busy}
                onClick={() => void run(() => api.plans.removeBlock(source.blockId))}
                className="h-11 rounded-full bg-bg px-5 text-[14px] font-medium text-text-dim"
              >
                Uit de planning
              </button>
            </>
          )}
          {source.type === 'event' && event && (
            confirming ? (
              <>
                <span className="self-center text-[14px] text-text">{event.title} verwijderen?</span>
                <button
                  disabled={busy}
                  onClick={() => void run(() => api.calendar.deleteEvent(event.id))}
                  className="h-11 rounded-full bg-prio-high px-5 text-[14px] font-semibold text-bg"
                >
                  Ja, verwijder
                </button>
                <button onClick={() => setConfirming(false)} className="h-11 rounded-full bg-bg px-5 text-[14px] text-text-dim">
                  Nee
                </button>
              </>
            ) : (
              <button
                onClick={() => setConfirming(true)}
                className="h-11 rounded-full bg-bg px-5 text-[14px] font-medium text-prio-high"
              >
                Afspraak verwijderen
              </button>
            )
          )}
        </div>
      </div>
    </Modal>
  )
}
