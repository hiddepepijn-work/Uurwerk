/**
 * What Jarvis can do, as tools over the same TimeTrackerAPI the screens use — so a task he
 * makes is a task like any other: it syncs, it plans, it reminds.
 *
 * Changing something is two steps, and the second does not depend on the chat. A writing
 * tool does not write: it stores a proposal here (an id, what it will do, until when it
 * holds) and returns a summary to read out. Hidde's "ja" becomes `confirm`, which runs the
 * stored proposals — not whatever the model reconstructs from the conversation — checks
 * the result against the database, and returns the real outcome, failures included. A
 * "ja" that arrives twice (a retry after "Load failed") finds the proposal already done
 * and says so instead of doing it again.
 */

import type { TimeTrackerAPI } from '@core/contract/api.js'
import type { IsoDate, JarvisCard, Priority, TaskPatch } from '@core/contract/types.js'

export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema for the input. */
  parameters: Record<string, unknown>
  /** It changes something. */
  writes: boolean
  /** It only becomes a proposal; `confirm` carries it out. */
  proposes?: boolean
}

const AREAS = ['stage', 'work', 'school', 'personal']

const date = { type: 'string', description: 'YYYY-MM-DD' }
const clock = { type: 'string', description: 'HH:MM' }
const PROPOSAL = ' Voorstel; na ja: confirm.'

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
})

export const TOOLS: ToolSpec[] = [
  {
    name: 'get_now',
    description: 'Datum, tijd, weekdag en ISO-week.',
    parameters: object({}),
    writes: false
  },
  {
    name: 'get_snapshot',
    description: 'Per dag planning en afspraken, open en te late taken, regels. Kenmerken t:… (taak) en a:… (afspraak) gelden als id. Standaard vandaag en morgen, max 14 dagen.',
    parameters: object({ from: date, to: date, tasks: { type: 'boolean', description: 'Taken meenemen, standaard ja' } }),
    writes: false
  },
  {
    name: 'get_agenda',
    description: 'Details van dagen als JSON (notities, locaties, reisblokken). Alleen als get_snapshot niet genoeg is.',
    parameters: object({ from: date, to: date }, ['from', 'to']),
    writes: false
  },
  {
    name: 'propose_plan',
    description: 'Taken achter elkaar in vrije tijd laten zetten door de code (taken, minuten, venster). Maakt één voorstel.',
    parameters: object(
      {
        taskIds: { type: 'array', items: { type: 'string' }, description: 'In deze volgorde' },
        after: { type: 'string', description: 'Vanaf YYYY-MM-DDTHH:MM; standaard nu' },
        before: { type: 'string', description: 'Uiterlijk YYYY-MM-DDTHH:MM; standaard een week later' },
        minutes: { type: 'integer', minimum: 15, description: 'Minuten per taak; standaard de schatting van de taak, anders 60' }
      },
      ['taskIds']
    ),
    writes: false
  },
  {
    name: 'list_rules',
    description: 'Vaste regels, hard en zacht.',
    parameters: object({}),
    writes: false
  },
  {
    name: 'add_rule',
    description: 'Vaste regel: stage_window (hard, dagen en uren voor stage) of note (zacht).' + PROPOSAL,
    parameters: object(
      {
        type: { type: 'string', enum: ['stage_window', 'note'] },
        description: { type: 'string', description: 'De regel in gewone woorden' },
        days: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 }, description: 'stage_window: 1 = maandag … 7 = zondag' },
        from: clock,
        to: clock
      },
      ['type', 'description']
    ),
    writes: true,
    proposes: true
  },
  {
    name: 'update_rule',
    description: 'Regel aanpassen of uitzetten.' + PROPOSAL,
    parameters: object(
      { ruleId: { type: 'string' }, active: { type: 'boolean' }, description: { type: 'string' } },
      ['ruleId']
    ),
    writes: true,
    proposes: true
  },
  {
    name: 'note_day_summary',
    description: 'Twee of drie zinnen over de dag, aan het eind van de dagafsluiting. Direct.',
    parameters: object({ summary: { type: 'string' } }, ['summary']),
    writes: true
  },
  {
    name: 'list_tasks',
    description: 'Taken met prioriteit, gebied, schatting, deadline en notitie. Standaard open taken.',
    parameters: object({
      status: { type: 'string', enum: ['active', 'open', 'done', 'blocked'], description: 'Standaard active' },
      search: { type: 'string' }
    }),
    writes: false
  },
  {
    name: 'list_projects',
    description: 'Projecten met hun gebied.',
    parameters: object({}),
    writes: false
  },
  {
    name: 'day_review',
    description: 'Hoe een dag ging: wat af is, wat niet, minuten per gebied.',
    parameters: object({ date }, ['date']),
    writes: false
  },
  {
    name: 'create_task',
    description:
      'Nieuwe taak; zet alles wat je hoorde in notes. Moet hij meteen op een tijd: geef date, start en end mee, dan is aanmaken en inplannen één voorstel.' +
      PROPOSAL,
    parameters: object(
      {
        title: { type: 'string' },
        areaId: { type: 'string', enum: AREAS },
        projectName: { type: 'string', description: 'Naam van een bestaand project, optioneel' },
        priority: { type: 'string', enum: ['high', 'medium', 'low'] },
        estimateMinutes: { type: 'integer', minimum: 0 },
        dueDate: date,
        earliestStartDate: date,
        notes: { type: 'string', description: 'Doel, Klaar als, Meenemen/voorbereiden, Bijzonderheden, Belangrijk: ja/nee' },
        focusMode: {
          type: 'string',
          enum: ['auto', 'always', 'never'],
          description: 'auto = stage altijd focus, privé vanaf 30 min; always/never als Hidde het anders wil'
        },
        date: { ...date, description: 'Optioneel: meteen inplannen op deze dag (met start en end)' },
        start: clock,
        end: clock
      },
      ['title', 'areaId']
    ),
    writes: true,
    proposes: true
  },
  {
    name: 'update_task',
    description: 'Taak aanpassen (titel, prioriteit, schatting, deadline, notitie, status).' + PROPOSAL,
    parameters: object(
      {
        taskId: { type: 'string' },
        title: { type: 'string' },
        priority: { type: 'string', enum: ['high', 'medium', 'low'] },
        estimateMinutes: { type: 'integer', minimum: 0 },
        dueDate: { type: ['string', 'null'] },
        notes: { type: 'string' },
        status: { type: 'string', enum: ['open', 'done', 'blocked'] }
      },
      ['taskId']
    ),
    writes: true,
    proposes: true
  },
  {
    name: 'schedule_task',
    description: 'Taak als blok op een vast tijdstip. Mag over andere taken; weigert over afspraken.' + PROPOSAL,
    parameters: object({ taskId: { type: 'string' }, date, start: clock, end: clock }, ['taskId', 'date', 'start', 'end']),
    writes: true,
    proposes: true
  },
  {
    name: 'plan_range',
    description: 'Planner plant een periode opnieuw; afspraken en handmatige blokken blijven.' + PROPOSAL,
    parameters: object({ from: date, to: date }, ['from', 'to']),
    writes: true,
    proposes: true
  },
  {
    name: 'clear_planning',
    description: 'Wist wat planner en Jarvis in een periode zetten; wat Hidde zette blijft.' + PROPOSAL,
    parameters: object({ from: date, to: date }, ['from', 'to']),
    writes: true,
    proposes: true
  },
  {
    name: 'create_appointment',
    description: 'Nieuwe afspraak (vaste tijd, met iemand of ergens), met reistijd.' + PROPOSAL,
    parameters: object(
      {
        title: { type: 'string' },
        date,
        start: clock,
        end: clock,
        areaId: { type: 'string', enum: AREAS },
        location: { type: 'string' },
        travelMinutes: { type: 'integer', minimum: 0, description: 'Reistijd heen in minuten, 0 = geen reis' },
        travelBack: { type: 'boolean', description: 'Dezelfde reis terug na afloop' },
        notes: { type: 'string', description: 'Doel, Wie, Meenemen/voorbereiden, Bijzonderheden, Belangrijk: ja/nee' }
      },
      ['title', 'date', 'start', 'end', 'areaId']
    ),
    writes: true,
    proposes: true
  },
  {
    name: 'move_appointment',
    description: 'Afspraak verzetten; reisblok schuift mee.' + PROPOSAL,
    parameters: object({ eventId: { type: 'string' }, date, start: clock, end: clock }, ['eventId', 'date', 'start', 'end']),
    writes: true,
    proposes: true
  },
  {
    name: 'delete_appointment',
    description: 'Afspraak verwijderen, met reisblokken.' + PROPOSAL,
    parameters: object({ eventId: { type: 'string' } }, ['eventId']),
    writes: true,
    proposes: true
  },
  {
    name: 'confirm',
    description: 'Voert openstaande voorstellen uit na een ja. Geeft de echte uitkomst terug; zeg precies die.',
    parameters: object({ pendingIds: { type: 'array', items: { type: 'string' } } }),
    writes: true
  },
  {
    name: 'cancel',
    description: 'Laat openstaande voorstellen vallen.',
    parameters: object({ pendingIds: { type: 'array', items: { type: 'string' } } }),
    writes: false
  },
  {
    name: 'start_timer',
    description: 'Timer starten, optioneel op een taak.' + PROPOSAL,
    parameters: object({ taskId: { type: 'string' } }),
    writes: true,
    proposes: true
  },
  {
    name: 'stop_timer',
    description: 'Timer stoppen.' + PROPOSAL,
    parameters: object({}),
    writes: true,
    proposes: true
  }
]

// ------------------------------------------------------------------ helpers

const pad = (n: number): string => String(n).padStart(2, '0')
const isoDate = (d: Date): IsoDate => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const minuteOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) throw new Error(`Geen geldige tijd: ${hhmm}`)
  return h! * 60 + m!
}
const at = (day: IsoDate, hhmm: string): number => new Date(`${day}T00:00:00`).getTime() + minuteOf(hhmm) * 60_000
const hm = (minute: number): string => `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`
const clockOf = (ms: number): string => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const dayStart = (day: IsoDate): number => new Date(`${day}T00:00:00`).getTime()

function daysBetween(from: IsoDate, to: IsoDate): IsoDate[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error('Datums als YYYY-MM-DD.')
  const days: IsoDate[] = []
  for (let ms = dayStart(from); ms <= dayStart(to); ms += 86_400_000) days.push(isoDate(new Date(ms + 3_600_000)))
  if (days.length === 0) throw new Error('De einddatum ligt voor de begindatum.')
  if (days.length > 31) throw new Error('Maximaal 31 dagen tegelijk.')
  return days
}

/** From today on: what is past stays as it happened. */
const fromToday = (from: IsoDate): IsoDate => {
  const today = isoDate(new Date())
  return from < today ? today : from
}

type Input = Record<string, unknown>

// ------------------------------------------------------------------ refs
// A uuid costs the model some twenty tokens every time it reads or repeats one. The
// snapshot shows the first six characters instead (t:ab12cd, a:ef34ab), and every tool
// takes either form. Six hex characters are unique among a few hundred rows; a clash is
// refused rather than guessed.

const ref = (prefix: 't' | 'a', id: string): string => `${prefix}:${id.replace(/-/g, '').slice(0, 6)}`
const bare = (value: string): string => value.replace(/^[ta]:/, '').replace(/-/g, '').toLowerCase()

async function resolveTask(api: TimeTrackerAPI, value: unknown): Promise<string> {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Geen taak opgegeven.')
  const direct = await api.tasks.get(value).catch(() => null)
  if (direct) return direct.id
  const wanted = bare(value)
  const matches = (await api.tasks.list({})).filter((task) => task.id.replace(/-/g, '').startsWith(wanted))
  if (matches.length === 1) return matches[0]!.id
  throw new Error(matches.length === 0 ? `Geen taak ${value}.` : `${value} past op meerdere taken; gebruik het hele id.`)
}

async function resolveEvent(api: TimeTrackerAPI, value: unknown): Promise<string> {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Geen afspraak opgegeven.')
  const wanted = bare(value)
  const now = Date.now()
  const events = await api.calendar.eventsInRange(now - 30 * 86_400_000, now + 120 * 86_400_000)
  const exact = events.find((event) => event.id === value)
  if (exact) return exact.id
  const matches = events.filter((event) => event.id.replace(/-/g, '').startsWith(wanted))
  if (matches.length === 1) return matches[0]!.id
  throw new Error(matches.length === 0 ? `Geen afspraak ${value}.` : `${value} past op meerdere afspraken; gebruik het hele id.`)
}

/** Turns refs in a proposal's input into full ids, before it is checked and stored. */
async function resolveRefs(api: TimeTrackerAPI, input: Input): Promise<Input> {
  const out: Input = { ...input }
  if ('taskId' in out && out.taskId !== undefined && out.taskId !== null) out.taskId = await resolveTask(api, out.taskId)
  if ('eventId' in out && out.eventId !== undefined) out.eventId = await resolveEvent(api, out.eventId)
  if (Array.isArray(out.taskIds)) out.taskIds = await Promise.all(out.taskIds.map((id) => resolveTask(api, id)))
  return out
}

const WEEKDAY = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za']
const shortDay = (day: IsoDate): string => {
  const d = new Date(`${day}T12:00:00`)
  return `${WEEKDAY[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}`
}

/** One line per item, for the model to read: the day's planning and appointments, the tasks, the rules. */
async function snapshot(api: TimeTrackerAPI, from: IsoDate, to: IsoDate, withTasks: boolean): Promise<string> {
  const days = daysBetween(from, to)
  if (days.length > 14) throw new Error('Maximaal 14 dagen tegelijk.')
  const lines: string[] = []
  const start = dayStart(days[0]!)
  const end = dayStart(days[days.length - 1]!) + 86_400_000
  const events = (await api.calendar.eventsInRange(start, end)).filter((event) => !event.cancelled)
  for (const day of days) {
    lines.push(shortDay(day))
    const plan = await api.plans.day(day)
    const items: Array<{ at: number; line: string }> = []
    for (const block of plan.blocks) {
      if (block.kind === 'break') continue
      const who = block.createdBy === 'jarvis' ? 'jarvis' : block.source === 'planner' ? 'planner' : 'zelf'
      const area = block.areaId ? ` [${block.areaId}]` : ''
      const task = block.taskId ? ` ${ref('t', block.taskId)}` : ''
      items.push({ at: block.startMin, line: `  ${hm(block.startMin)}-${hm(block.endMin)} ${block.taskTitle ?? block.title ?? block.kind}${area} (${who})${task}` })
    }
    for (const event of events) {
      if (isoDate(new Date(event.startsAt)) !== day) continue
      const what = event.kind === 'travel' ? 'reis' : 'afspraak'
      const when = event.allDay ? 'hele dag' : `${clockOf(event.startsAt)}-${clockOf(event.endsAt)}`
      const where = event.location ? ` @${event.location}` : ''
      items.push({
        at: event.allDay ? -1 : Math.round((event.startsAt - dayStart(day)) / 60_000),
        line: `  ${when} ${event.title} [${what}${event.areaId ? `, ${event.areaId}` : ''}]${where} ${ref('a', event.id)}`
      })
    }
    items.sort((a, b) => a.at - b.at)
    lines.push(...(items.length > 0 ? items.map((item) => item.line) : ['  (niets)']))
  }
  if (withTasks) {
    const today = isoDate(new Date())
    const tasks = await api.tasks.list({ status: 'active' })
    lines.push('', 'Open taken')
    for (const task of tasks.slice(0, 60)) {
      const late = task.dueDate !== null && task.dueDate < today ? ' TE LAAT' : ''
      const estimate = task.estimateMin ? `, ${task.estimateMin} min` : ''
      const due = task.dueDate ? `, deadline ${task.dueDate}` : ''
      lines.push(`  ${ref('t', task.id)} ${task.title} [${task.areaId ?? '-'}] ${task.priority}${estimate}${due}${late}`)
    }
  }
  const rules = await api.assistant.rules()
  if (rules.length > 0) {
    lines.push('', 'Regels')
    for (const rule of rules) lines.push(`  ${rule.kind === 'hard' ? 'hard' : 'zacht'}: ${rule.description}`)
  }
  return lines.join('\n')
}

// --------------------------------------------------------------- placing
// The planner's side of propose_plan: the model says which tasks, how long and within
// which window; this finds the room. Walls are appointments, breaks and anything not the
// planner's own; stage work only fits inside the day's internship window, everything else
// only outside it — the same hard rule the range planner keeps.

interface Placement {
  taskId: string
  title: string
  date: IsoDate
  start: string
  end: string
}

async function freeStretches(
  api: TimeTrackerAPI,
  day: IsoDate,
  stage: boolean,
  notBefore: number,
  notAfter: number
): Promise<Array<[number, number]>> {
  const plan = await api.plans.day(day)
  const availability = plan.availability
  let from = Math.max(notBefore, availability?.startMin ?? 8 * 60)
  let to = Math.min(notAfter, availability?.endMin ?? 22 * 60)
  if (availability && !availability.enabled) return []
  const stageFrom = availability?.stageStartMin ?? null
  const stageTo = availability?.stageEndMin ?? null
  if (stage) {
    if (stageFrom === null || stageTo === null) return []
    from = Math.max(from, stageFrom)
    to = Math.min(to, stageTo)
  }
  if (to <= from) return []

  const walls: Array<[number, number]> = []
  for (const block of plan.blocks) {
    const replaceable = block.source === 'planner' && !block.locked && !block.fixed && block.createdBy !== 'jarvis'
    if (!replaceable || block.kind === 'break') walls.push([block.startMin, block.endMin])
  }
  for (const fixed of plan.events) walls.push([fixed.startMin, fixed.endMin])
  const events = await api.calendar.eventsInRange(dayStart(day), dayStart(day) + 86_400_000)
  for (const event of events) {
    if (event.cancelled) continue
    if (event.allDay) return []
    walls.push([Math.round((event.startsAt - dayStart(day)) / 60_000), Math.round((event.endsAt - dayStart(day)) / 60_000)])
  }
  // Non-stage work goes around the internship window, not through it.
  if (!stage && stageFrom !== null && stageTo !== null) walls.push([stageFrom, stageTo])

  walls.sort((a, b) => a[0] - b[0])
  const free: Array<[number, number]> = []
  let cursor = from
  for (const [wallFrom, wallTo] of walls) {
    if (wallTo <= cursor) continue
    if (wallFrom >= to) break
    if (wallFrom > cursor) free.push([cursor, Math.min(wallFrom, to)])
    cursor = Math.max(cursor, wallTo)
  }
  if (cursor < to) free.push([cursor, to])
  return free
}

async function placeInOrder(api: TimeTrackerAPI, input: Input): Promise<{ placements: Placement[]; notPlaced: string[] }> {
  const taskIds = (input.taskIds as string[]) ?? []
  if (taskIds.length === 0) throw new Error('Geen taken opgegeven.')
  const now = new Date()
  const after = typeof input.after === 'string' ? new Date(input.after) : now
  if (Number.isNaN(after.getTime())) throw new Error('after als YYYY-MM-DDTHH:MM.')
  const start = after < now ? now : after
  const before = typeof input.before === 'string' ? new Date(input.before) : new Date(start.getTime() + 7 * 86_400_000)
  if (Number.isNaN(before.getTime()) || before <= start) throw new Error('before moet na after liggen.')

  const placements: Placement[] = []
  const notPlaced: string[] = []
  // Where the previous task ended: the next one goes after it.
  let cursorDay = isoDate(start)
  let cursorMin = start.getHours() * 60 + start.getMinutes()
  const lastDay = isoDate(before)
  for (const taskId of taskIds) {
    const task = await api.tasks.get(taskId)
    if (!task) throw new Error(`Geen taak ${taskId}.`)
    const minutes = typeof input.minutes === 'number' ? input.minutes : task.estimateMin && task.estimateMin <= 240 ? task.estimateMin : 60
    const stage = task.areaId === 'stage'
    let placed: Placement | null = null
    for (let day = cursorDay; day <= lastDay && !placed; day = isoDate(new Date(dayStart(day) + 36 * 3_600_000))) {
      const notBefore = day === cursorDay ? cursorMin : 0
      const notAfter = day === lastDay ? before.getHours() * 60 + before.getMinutes() : 24 * 60
      const taken: Array<[number, number]> = placements
        .filter((entry) => entry.date === day)
        .map((entry) => [minuteOf(entry.start), minuteOf(entry.end)])
      for (const [from, to] of await freeStretches(api, day, stage, notBefore, notAfter)) {
        // Skip what an earlier task in this same proposal already takes.
        let begin = from
        for (const [takenFrom, takenTo] of taken) if (takenFrom < begin + minutes && takenTo > begin) begin = Math.max(begin, takenTo)
        if (begin + minutes <= to) {
          placed = { taskId, title: task.title, date: day, start: hm(begin), end: hm(begin + minutes) }
          break
        }
      }
    }
    if (!placed) {
      notPlaced.push(`${task.title}: geen ruimte van ${minutes} min voor ${lastDay}`)
      continue
    }
    placements.push(placed)
    cursorDay = placed.date
    cursorMin = minuteOf(placed.end)
  }
  return { placements, notPlaced }
}

/** A stage window rule, written where the planner reads it: the availability rows. */
async function applyStageWindow(api: TimeTrackerAPI, days: number[], from: string, to: string): Promise<number> {
  const startMin = minuteOf(from)
  const endMin = minuteOf(to)
  if (endMin <= startMin) throw new Error('Het einde ligt voor het begin.')
  const { toIsoWeek } = await import('@core/util/time.js')
  // The recurring pattern plus the weeks already adjusted by hand, from this week on.
  const seen = new Set<string>()
  let changed = 0
  for (let week = 0; week < 8; week++) {
    for (const row of await api.availability.forWeek(toIsoWeek(new Date(Date.now() + week * 7 * 86_400_000)))) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
      const allowed = days.includes(row.weekday)
      await api.availability.save({
        ...row,
        stageStartMin: allowed ? startMin : null,
        stageEndMin: allowed ? endMin : null
      })
      changed += 1
    }
  }
  return changed
}

// ---------------------------------------------------------------- proposals
// Stored in the database (_jarvis_proposals, local to this copy), so a proposal outlives
// a restart and what a "ja" did can be looked up afterwards.

/** Long enough to think it over; short enough that a stale "ja" does nothing. */
const PROPOSAL_MS = 30 * 60_000

/** Proposals being carried out right now: a second "ja" meanwhile must not run them again. */
const inFlight = new Set<string>()

/** What a proposal will do, in words to read out — with names, not ids. */
async function describe(api: TimeTrackerAPI, name: string, input: Input): Promise<string> {
  const taskTitle = async (id: unknown): Promise<string> =>
    (typeof id === 'string' && (await api.tasks.get(id).catch(() => null))?.title) || 'onbekende taak'
  switch (name) {
    case 'create_task':
      return `Nieuwe taak "${String(input.title)}" (${String(input.areaId)}${typeof input.estimateMinutes === 'number' ? `, ${input.estimateMinutes} min` : ''}${input.dueDate ? `, deadline ${String(input.dueDate)}` : ''})${plannedAt(input) ? `, ingepland op ${String(input.date)} ${String(input.start)}–${String(input.end)}` : ''}`
    case 'update_task': {
      const changes = Object.keys(input).filter((key) => key !== 'taskId')
      return `Taak "${await taskTitle(input.taskId)}" aanpassen: ${changes.join(', ') || 'niets'}`
    }
    case 'schedule_task':
      return `Taak "${await taskTitle(input.taskId)}" inplannen op ${String(input.date)} ${String(input.start)}–${String(input.end)}`
    case 'plan_range':
      return `Planning van ${fromToday(String(input.from))} t/m ${String(input.to)} opnieuw laten maken (afspraken en handmatige blokken blijven)`
    case 'clear_planning':
      return `Planning van ${fromToday(String(input.from))} t/m ${String(input.to)} wissen (afspraken en wat Hidde zelf zette blijven)`
    case 'create_appointment':
      return `Nieuwe afspraak "${String(input.title)}" op ${String(input.date)} ${String(input.start)}–${String(input.end)}${typeof input.travelMinutes === 'number' && input.travelMinutes > 0 ? `, ${input.travelMinutes} min reistijd` : ''}`
    case 'move_appointment':
      return `Afspraak verzetten naar ${String(input.date)} ${String(input.start)}–${String(input.end)}`
    case 'delete_appointment':
      return 'Afspraak verwijderen'
    case 'apply_day_plan':
      return `Dagplan van ${String(input.date)} laten invullen door de planner`
    case 'add_rule':
      return `Regel toevoegen (${input.type === 'stage_window' ? 'hard' : 'zacht'}): ${String(input.description)}`
    case 'update_rule':
      return `Regel ${input.active === false ? 'uitzetten' : 'aanpassen'}${input.description ? `: ${String(input.description)}` : ''}`
    case 'start_timer':
      return input.taskId ? `Timer starten op "${await taskTitle(input.taskId)}"` : 'Timer starten'
    case 'stop_timer':
      return 'Timer stoppen'
  }
  return name
}

/** Checks what can be checked before the "ja", so a proposal that cannot work is not asked. */
/** A new task that is to go into the day right away. */
const plannedAt = (input: Input): boolean =>
  typeof input.date === 'string' && typeof input.start === 'string' && typeof input.end === 'string'

async function precheck(api: TimeTrackerAPI, name: string, input: Input): Promise<void> {
  if (name === 'schedule_task') await slotFor(api, input)
  if (name === 'create_task' && (input.date || input.start || input.end)) {
    if (!plannedAt(input)) throw new Error('Meteen inplannen vraagt date, start én end.')
    if (minuteOf(String(input.end)) <= minuteOf(String(input.start))) throw new Error('Het einde ligt voor het begin.')
  }
  if (name === 'add_rule' && input.type === 'stage_window') {
    if (!Array.isArray(input.days) || typeof input.from !== 'string' || typeof input.to !== 'string') {
      throw new Error('Een stage_window heeft days, from en to nodig.')
    }
    if (minuteOf(input.to) <= minuteOf(input.from)) throw new Error('Het einde ligt voor het begin.')
  }
  if (name === 'update_rule' && !(await api.assistant.rules()).some((rule) => rule.id === input.ruleId || rule.id.startsWith(bare(String(input.ruleId))))) {
    throw new Error(`Geen regel ${String(input.ruleId)}.`)
  }
  if (name === 'plan_range' || name === 'clear_planning') daysBetween(fromToday(String(input.from)), String(input.to))
  if (['create_appointment', 'move_appointment'].includes(name)) {
    if (minuteOf(String(input.end)) <= minuteOf(String(input.start))) throw new Error('Het einde ligt voor het begin.')
  }
}

async function propose(api: TimeTrackerAPI, name: string, given: Input): Promise<unknown> {
  let input: Input
  try {
    input = await resolveRefs(api, given)
    await precheck(api, name, input)
  } catch (error) {
    return { error: `Kan niet: ${error instanceof Error ? error.message : String(error)}` }
  }
  const summary = await describe(api, name, input)
  const proposal = await api.assistant.propose({ tool: name, payload: input, summary, expiresAt: Date.now() + PROPOSAL_MS })
  return {
    pendingId: proposal.id,
    summary,
    next: 'Nog niet uitgevoerd. Vat samen en vraag "Zal ik dat zo doen?". Pas na een ja: confirm.'
  }
}

async function confirm(api: TimeTrackerAPI, input: Input): Promise<unknown> {
  const wanted = Array.isArray(input.pendingIds) ? input.pendingIds.map(String) : null
  const chosen = wanted
    ? await Promise.all(wanted.map((id) => api.assistant.proposal(id)))
    : await api.assistant.pendingProposals()
  if (chosen.length === 0) return { error: 'Er staat geen voorstel open. Er is niets uitgevoerd.' }

  const executed: Array<{ summary: string; result: unknown; cards: JarvisCard[] }> = []
  const failed: Array<{ summary: string; error: string }> = []
  const alreadyDone: string[] = []
  for (const [index, proposal] of chosen.entries()) {
    if (!proposal) {
      failed.push({ summary: `voorstel ${wanted?.[index] ?? '?'}`, error: 'bestaat niet (meer)' })
      continue
    }
    if (proposal.status === 'executed' || inFlight.has(proposal.id)) {
      alreadyDone.push(proposal.summary)
      continue
    }
    if (proposal.status !== 'pending') {
      failed.push({
        summary: proposal.summary,
        error: proposal.status === 'cancelled' ? 'was afgezegd' : proposal.status === 'expired' ? 'verlopen' : proposal.error ?? 'mislukt'
      })
      continue
    }
    if (Date.now() > proposal.expiresAt) {
      await api.assistant.settleProposal(proposal.id, { status: 'expired', error: 'verlopen' })
      failed.push({ summary: proposal.summary, error: 'verlopen, maak een nieuw voorstel' })
      continue
    }
    inFlight.add(proposal.id)
    try {
      const result = await execute(api, proposal.tool, proposal.payload)
      await api.assistant.settleProposal(proposal.id, { status: 'executed', result })
      executed.push({ summary: proposal.summary, result, cards: cardsFor(proposal.tool, proposal.payload, result) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await api.assistant.settleProposal(proposal.id, { status: 'failed', error: message })
      failed.push({ summary: proposal.summary, error: message })
    } finally {
      inFlight.delete(proposal.id)
    }
  }
  return {
    executed,
    failed,
    alreadyDone,
    // Worded as a note, not as a line to say: a model once read "Vertel Hidde precies dit" out loud.
    note: 'Niet voorlezen. Noem in je eigen woorden alleen wat in executed en failed staat, niets anders.'
  }
}

/** What a carried-out proposal changed, as cards for the laptop's Jarvis corner. */
function cardsFor(tool: string, input: Input, result: unknown): JarvisCard[] {
  const out = (result ?? {}) as Record<string, unknown>
  const slot = (date: unknown, start: unknown, end: unknown): string => `${shortDay(String(date))} ${String(start)}–${String(end)}`
  const card = (kind: JarvisCard['kind'], action: JarvisCard['action'], title: unknown, when: string | null = null, date: unknown = null): JarvisCard => ({
    kind,
    action,
    title: String(title ?? ''),
    when,
    date: typeof date === 'string' ? date : null
  })
  switch (tool) {
    case 'create_task':
      return [
        card('taak', 'nieuw', input.title, input.dueDate ? `deadline ${shortDay(String(input.dueDate))}` : null),
        ...(out.placed ? [card('planning', 'nieuw', input.title, slot(input.date, input.start, input.end), input.date)] : [])
      ]
    case 'update_task':
      return [card('taak', input.status === 'done' ? 'af' : 'gewijzigd', out.done ?? out.updated)]
    case 'schedule_task':
      return [card('planning', 'nieuw', out.task, slot(input.date, input.start, input.end), input.date)]
    case 'place_tasks':
      return ((input.placements as Placement[]) ?? []).map((entry) =>
        card('planning', 'nieuw', entry.title, slot(entry.date, entry.start, entry.end), entry.date)
      )
    case 'plan_range':
      return [card('planning', 'gewijzigd', `${String(out.plannedBlocks)} blokken opnieuw gepland`, `${shortDay(String(out.from))} – ${shortDay(String(out.to))}`, out.from)]
    case 'clear_planning':
      return [card('planning', 'weg', `${String(out.removedBlocks)} blokken weggehaald`, `${shortDay(String(out.from))} – ${shortDay(String(out.to))}`, out.from)]
    case 'apply_day_plan':
      return [card('planning', 'gewijzigd', `Dagplan ${shortDay(String(input.date))}`, null, input.date)]
    case 'create_appointment':
      return [card('afspraak', 'nieuw', input.title, slot(input.date, input.start, input.end), input.date)]
    case 'move_appointment':
      return [card('afspraak', 'gewijzigd', out.moved, slot(input.date, input.start, input.end), input.date)]
    case 'delete_appointment':
      return [card('afspraak', 'weg', out.title ?? 'Afspraak')]
    case 'add_rule':
      return [card('regel', 'nieuw', out.added)]
    case 'update_rule':
      return [card('regel', 'gewijzigd', out.updated)]
    case 'start_timer':
      return [card('timer', 'nieuw', 'Timer gestart', typeof out.at === 'string' ? out.at : null)]
    case 'stop_timer':
      return [card('timer', 'af', 'Timer gestopt')]
  }
  return []
}

async function cancel(api: TimeTrackerAPI, input: Input): Promise<unknown> {
  const wanted = Array.isArray(input.pendingIds) ? new Set(input.pendingIds.map(String)) : null
  let count = 0
  for (const proposal of await api.assistant.pendingProposals()) {
    if (!wanted || wanted.has(proposal.id)) {
      await api.assistant.settleProposal(proposal.id, { status: 'cancelled' })
      count += 1
    }
  }
  return { cancelled: count }
}

// ------------------------------------------------------------------ run

/**
 * Runs one tool call. Returns what the model reads back — small and readable, never whole
 * rows full of ids it does not need.
 */
export async function runTool(api: TimeTrackerAPI, name: string, input: Input): Promise<unknown> {
  const spec = TOOLS.find((tool) => tool.name === name)
  if (!spec) throw new Error(`Onbekende tool: ${name}`)
  if (spec.proposes) return propose(api, name, input)

  switch (name) {
    case 'confirm':
      return confirm(api, input)

    case 'cancel':
      return cancel(api, input)

    case 'get_snapshot': {
      const from = typeof input.from === 'string' ? input.from : isoDate(new Date())
      const to = typeof input.to === 'string' ? input.to : isoDate(new Date(Date.now() + 86_400_000))
      return snapshot(api, from, to, input.tasks !== false)
    }

    case 'propose_plan': {
      let resolved: Input
      let found: { placements: Placement[]; notPlaced: string[] }
      try {
        resolved = await resolveRefs(api, input)
        found = await placeInOrder(api, resolved)
      } catch (error) {
        return { error: `Kan niet: ${error instanceof Error ? error.message : String(error)}` }
      }
      if (found.placements.length === 0) return { error: 'Geen ruimte gevonden.', notPlaced: found.notPlaced }
      const summary = found.placements.map((entry) => `${entry.title} ${shortDay(entry.date)} ${entry.start}–${entry.end}`).join('; ')
      const proposal = await api.assistant.propose({
        tool: 'place_tasks',
        payload: { placements: found.placements },
        summary: `Inplannen: ${summary}`,
        expiresAt: Date.now() + PROPOSAL_MS
      })
      return {
        pendingId: proposal.id,
        summary: proposal.summary,
        notPlaced: found.notPlaced,
        next: 'Nog niet uitgevoerd. Vat samen en vraag "Zal ik dat zo doen?". Pas na een ja: confirm.'
      }
    }

    case 'list_rules':
      return (await api.assistant.rules()).map((rule) => ({
        ruleId: rule.id.slice(0, 8),
        kind: rule.kind,
        type: rule.type,
        description: rule.description
      }))

    case 'note_day_summary': {
      const summary = String(input.summary ?? '').trim()
      if (!summary) return { error: 'Geen samenvatting.' }
      await api.assistant.markDay(isoDate(new Date()), { summary: summary.slice(0, 600) })
      return { saved: true }
    }

    case 'get_now': {
      const now = new Date()
      return {
        date: isoDate(now),
        time: clockOf(now.getTime()),
        weekday: now.toLocaleDateString('nl-NL', { weekday: 'long' }),
        isoWeek: await weekKey(now)
      }
    }

    case 'get_agenda': {
      const from = String(input.from)
      const to = String(input.to)
      const start = new Date(`${from}T00:00:00`).getTime()
      const end = new Date(`${to}T00:00:00`).getTime() + 86_400_000
      if (end - start > 21 * 86_400_000) throw new Error('Maximaal 21 dagen tegelijk.')

      const days: Array<Record<string, unknown>> = []
      for (let ms = start; ms < end; ms += 86_400_000) {
        const day = isoDate(new Date(ms))
        const plan = await api.plans.day(day)
        days.push({
          date: day,
          weekday: new Date(ms).toLocaleDateString('nl-NL', { weekday: 'long' }),
          blocks: plan.blocks.map((block) => ({
            from: hm(block.startMin),
            to: hm(block.endMin),
            kind: block.kind,
            title: block.taskTitle ?? block.title,
            taskId: block.taskId,
            area: block.areaId,
            project: block.projectName,
            byHand: block.source !== 'planner'
          }))
        })
      }
      const events = (await api.calendar.eventsInRange(start, end)).filter((event) => !event.cancelled)
      return {
        days,
        appointments: events.map((event) => ({
          eventId: event.id,
          date: isoDate(new Date(event.startsAt)),
          from: event.allDay ? 'hele dag' : clockOf(event.startsAt),
          to: event.allDay ? null : clockOf(event.endsAt),
          title: event.title,
          kind: event.kind,
          travelFor: event.parentEventId,
          location: event.location,
          area: event.areaId,
          notes: event.description
        }))
      }
    }

    case 'list_tasks': {
      const tasks = await api.tasks.list({
        status: (input.status as 'active' | 'open' | 'done' | 'blocked' | undefined) ?? 'active',
        ...(typeof input.search === 'string' ? { search: input.search } : {})
      })
      return tasks.slice(0, 80).map((task) => ({
        taskId: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority,
        area: task.areaId,
        project: task.projectName,
        estimateMinutes: task.estimateMin,
        loggedMinutes: task.loggedMin,
        dueDate: task.dueDate,
        overdue: task.dueDate !== null && task.dueDate < isoDate(new Date()),
        postponed: task.postponedCount,
        notes: task.notes
      }))
    }

    case 'list_projects': {
      const projects = await api.projects.list()
      return projects.filter((project) => !project.archived).map((project) => ({ name: project.name, area: project.areaId }))
    }

    case 'day_review': {
      const day = String(input.date)
      const [plan, open, breakdown] = await Promise.all([
        api.plans.day(day),
        api.tasks.list({ status: 'active' }),
        api.breakdown.day(day)
      ])
      const openIds = new Set(open.map((task) => task.id))
      const planned = new Map<string, string>()
      for (const block of plan.blocks) {
        if (block.kind === 'task' && block.taskId) planned.set(block.taskId, block.taskTitle ?? '')
      }
      return {
        date: day,
        done: [...planned].filter(([id]) => !openIds.has(id)).map(([, title]) => title),
        notDone: [...planned].filter(([id]) => openIds.has(id)).map(([taskId, title]) => ({ taskId, title })),
        workedMinutesByArea: breakdown.byArea,
        totalMinutes: breakdown.totalMin
      }
    }

  }
  throw new Error(`Tool zonder uitvoering: ${name}`)
}

// ------------------------------------------------------------ carrying out

/**
 * Where a task block would go, and what it would push aside. Appointments and blocks set by
 * hand are walls; the planner's own blocks there make way.
 */
async function slotFor(
  api: TimeTrackerAPI,
  input: Input
): Promise<{
  day: IsoDate
  startMin: number
  endMin: number
  areaId: string | null
  title: string
  replaces: Array<{ id: string; title: string }>
  /** Other tasks at that time: tasks may overlap, but it is worth saying. */
  alongside: string[]
}> {
  const day = String(input.date)
  const startMin = minuteOf(String(input.start))
  const endMin = minuteOf(String(input.end))
  if (endMin <= startMin) throw new Error('Het einde ligt voor het begin.')
  if (day < isoDate(new Date())) throw new Error('Die dag is al voorbij.')
  const task = typeof input.taskId === 'string' ? await api.tasks.get(input.taskId) : null
  if (!task) throw new Error('Die taak bestaat niet; haal de taskId op met list_tasks.')

  const plan = await api.plans.day(day)
  const overlaps = (from: number, to: number): boolean => from < endMin && to > startMin
  const walls: string[] = []
  const alongside: string[] = []
  const replaces: Array<{ id: string; title: string }> = []
  for (const block of plan.blocks) {
    if (!overlaps(block.startMin, block.endMin)) continue
    const title = block.taskTitle ?? block.title ?? block.kind
    const span = `${title} ${hm(block.startMin)}–${hm(block.endMin)}`
    if (block.source === 'planner' && !block.locked && !block.fixed) replaces.push({ id: block.id, title })
    // Tasks may run through each other; a fixed meeting or blocked time may not be planned over.
    else if (block.kind === 'task') alongside.push(span)
    else walls.push(span)
  }
  const events = await api.calendar.eventsInRange(dayStart(day), dayStart(day) + 86_400_000)
  for (const event of events) {
    if (event.cancelled || event.allDay) continue
    const from = Math.round((event.startsAt - dayStart(day)) / 60_000)
    const to = Math.round((event.endsAt - dayStart(day)) / 60_000)
    if (overlaps(from, to)) walls.push(`${event.title} ${clockOf(event.startsAt)}–${clockOf(event.endsAt)}`)
  }
  if (walls.length > 0) throw new Error(`Overlapt met ${walls.join(', ')}`)
  return { day, startMin, endMin, areaId: task.areaId, title: task.title, replaces, alongside }
}

/** The planner's own blocks on a day: what plan_range replaces and clear_planning removes. */
const plannerBlocks = async (api: TimeTrackerAPI, day: IsoDate) =>
  (await api.plans.day(day)).blocks.filter((block) => block.source === 'planner' && !block.locked && !block.fixed)

/** Does the work of a confirmed proposal, and reads the result back from the database. */
async function execute(api: TimeTrackerAPI, name: string, input: Input): Promise<unknown> {
  switch (name) {
    case 'create_task': {
      let projectId: string | null = null
      // "—", "-" or "geen" is a model's way of saying no project.
      if (typeof input.projectName === 'string' && !/^[\s\-–—]*$|^(geen|none|null)$/i.test(input.projectName.trim())) {
        const wanted = input.projectName.trim().toLowerCase()
        const project = (await api.projects.list()).find((entry) => entry.name.toLowerCase() === wanted)
        if (!project) throw new Error(`Geen project "${input.projectName}". Kies uit list_projects of laat het leeg.`)
        projectId = project.id
      }
      const task = await api.tasks.create({
        title: String(input.title),
        areaId: String(input.areaId),
        projectId,
        priority: (input.priority as Priority | undefined) ?? 'medium',
        estimateMin: typeof input.estimateMinutes === 'number' ? input.estimateMinutes : null,
        dueDate: (input.dueDate as string | undefined) ?? null,
        earliestStartDate: (input.earliestStartDate as string | undefined) ?? null,
        notes: (input.notes as string | undefined) ?? null,
        focusMode: (input.focusMode as 'auto' | 'always' | 'never' | undefined) ?? 'auto'
      })
      if (!(await api.tasks.get(task.id))) throw new Error('De taak staat na het aanmaken niet in de database.')
      if (!plannedAt(input)) return { created: task.title, taskId: task.id, focus: task.focusMode }
      // Made and placed in one go; if the placing fails, the task still stands and he says so.
      try {
        const placed = (await execute(api, 'schedule_task', { taskId: task.id, date: input.date, start: input.start, end: input.end })) as Record<string, unknown>
        return { created: task.title, taskId: task.id, focus: task.focusMode, ...placed }
      } catch (error) {
        return { created: task.title, taskId: task.id, notPlaced: error instanceof Error ? error.message : String(error) }
      }
    }

    case 'update_task': {
      const taskId = String(input.taskId)
      if (input.status === 'done') {
        const task = await api.tasks.complete(taskId, true)
        return { done: task.title }
      }
      const patch: TaskPatch = {}
      if (typeof input.title === 'string') patch.title = input.title
      if (typeof input.priority === 'string') patch.priority = input.priority as Priority
      if (typeof input.estimateMinutes === 'number') patch.estimateMin = input.estimateMinutes
      if (input.dueDate !== undefined) patch.dueDate = input.dueDate as string | null
      if (typeof input.notes === 'string') patch.notes = input.notes
      if (typeof input.status === 'string') patch.status = input.status as TaskPatch['status']
      const task = await api.tasks.update(taskId, patch)
      return { updated: task.title }
    }

    case 'schedule_task': {
      const slot = await slotFor(api, input)
      for (const block of slot.replaces) await api.plans.removeBlock(block.id)
      const current = await api.plans.day(slot.day)
      let planId = current.plan?.status === 'accepted' ? current.plan.id : null
      const needsAccept = planId === null
      if (!planId) {
        const draft = await api.plans.draft(slot.day)
        if (!draft.plan) throw new Error('Kon voor die dag geen plan openen.')
        planId = draft.plan.id
      }
      const block = await api.plans.addBlock(planId, {
        taskId: String(input.taskId),
        areaId: slot.areaId,
        date: slot.day,
        startMin: slot.startMin,
        endMin: slot.endMin,
        kind: 'task',
        source: 'manual',
        locked: true,
        createdBy: 'jarvis'
      })
      if (needsAccept) await api.plans.accept(planId)
      const after = await api.plans.day(slot.day)
      if (!after.blocks.some((entry) => entry.startMin === block.startMin && entry.taskId === block.taskId)) {
        throw new Error('Het blok staat na het opslaan niet in de planning.')
      }
      return {
        task: slot.title,
        placed: `${slot.day} ${hm(slot.startMin)}–${hm(slot.endMin)}`,
        ...(slot.alongside.length > 0 ? { alongside: slot.alongside } : {}),
        madeWayFor: slot.replaces.map((entry) => entry.title)
      }
    }

    case 'plan_range': {
      const days = daysBetween(fromToday(String(input.from)), String(input.to))
      const before = (await Promise.all(days.map((day) => plannerBlocks(api, day)))).flat().length
      const result = await api.planner.applyRange(days[0]!, days[days.length - 1]!)
      const after = (await Promise.all(days.map((day) => plannerBlocks(api, day)))).flat()
      return {
        from: days[0],
        to: days[days.length - 1],
        removedOldBlocks: before,
        plannedBlocks: after.filter((block) => block.kind === 'task').length,
        plannedHours: Math.round((result.plannedMin / 60) * 10) / 10,
        notPlaced: result.unplaced.map((entry) => `${entry.taskTitle} (${entry.minutes} min): ${entry.reason}`)
      }
    }

    case 'clear_planning': {
      const days = daysBetween(fromToday(String(input.from)), String(input.to))
      // The planner's own blocks and what Jarvis placed; never what Hidde set himself.
      const ours = async (day: IsoDate) =>
        (await api.plans.day(day)).blocks.filter(
          (block) => block.createdBy === 'jarvis' || (block.source === 'planner' && !block.locked && !block.fixed)
        )
      let removed = 0
      for (const day of days) {
        for (const block of await ours(day)) {
          await api.plans.removeBlock(block.id)
          removed += 1
        }
      }
      const left = (await Promise.all(days.map((day) => ours(day)))).flat().length
      if (left > 0) throw new Error(`${removed} blokken verwijderd, maar er staan er nog ${left}.`)
      return { removedBlocks: removed, from: days[0], to: days[days.length - 1] }
    }

    case 'create_appointment': {
      const day = String(input.date)
      const created = await api.calendar.createEvent({
        title: String(input.title),
        location: (input.location as string | undefined) ?? null,
        description: (input.notes as string | undefined) ?? null,
        startsAt: at(day, String(input.start)),
        endsAt: at(day, String(input.end)),
        origin: 'uurwerk',
        classificationStatus: 'unclassified',
        includeInPlanning: true,
        registrationMode: 'none',
        countsAsWorked: false,
        createdBy: 'jarvis'
      })
      const travel = typeof input.travelMinutes === 'number' ? input.travelMinutes : 0
      await api.calendar.classify(created.id, {
        areaId: String(input.areaId),
        organizationId: null,
        projectId: null,
        workTypeId: null,
        remember: false,
        includeInPlanning: true,
        registrationMode: 'none',
        countsAsWorked: false,
        ...(travel > 0
          ? { travel: { outboundMin: travel, returnMin: input.travelBack === false ? 0 : travel, countsAsWorked: false } }
          : {})
      })
      const leave = travel > 0 ? hm(minuteOf(String(input.start)) - travel) : null
      return {
        created: created.title,
        eventId: created.id,
        leaveAt: leave,
        reminders: leave
          ? `Meldingen om ${hm(minuteOf(leave) - 30)} (spullen) en ${hm(minuteOf(leave) - 15)} (vertrekken)`
          : `Meldingen om ${hm(minuteOf(String(input.start)) - 30)} en ${hm(minuteOf(String(input.start)) - 15)}`
      }
    }

    case 'move_appointment': {
      const day = String(input.date)
      const moved = await api.calendar.move(String(input.eventId), at(day, String(input.start)), at(day, String(input.end)))
      return { moved: moved.title, to: `${day} ${clockOf(moved.startsAt)}–${clockOf(moved.endsAt)}` }
    }

    case 'delete_appointment': {
      const now = Date.now()
      const title = (await api.calendar.eventsInRange(now - 30 * 86_400_000, now + 120 * 86_400_000)).find(
        (event) => event.id === input.eventId
      )?.title
      await api.calendar.deleteEvent(String(input.eventId))
      return { deleted: true, title: title ?? null }
    }

    case 'start_timer': {
      const run = await api.tracking.startRun((input.taskId as string | undefined) ?? null)
      return { started: true, at: clockOf(run.startedAt) }
    }

    case 'stop_timer': {
      await api.tracking.stopRun()
      return { stopped: true }
    }

    case 'place_tasks': {
      // Everything of one proposal in one go, each slot checked again: the agenda may have
      // changed between the proposal and the "ja".
      const placed: string[] = []
      for (const entry of (input.placements as Placement[]) ?? []) {
        const outcome = (await execute(api, 'schedule_task', {
          taskId: entry.taskId,
          date: entry.date,
          start: entry.start,
          end: entry.end
        })) as { placed: string }
        placed.push(`${entry.title} ${outcome.placed}`)
      }
      return { placedCount: placed.length, placed }
    }

    case 'add_rule': {
      const stage = input.type === 'stage_window'
      const rule = await api.assistant.addRule({
        kind: stage ? 'hard' : 'soft',
        type: String(input.type),
        description: String(input.description),
        config: stage ? { days: input.days, from: input.from, to: input.to } : {}
      })
      const rows = stage
        ? await applyStageWindow(api, input.days as number[], String(input.from), String(input.to))
        : 0
      return { added: rule.description, kind: rule.kind, availabilityRowsChanged: rows }
    }

    case 'update_rule': {
      const wanted = bare(String(input.ruleId))
      const rule = (await api.assistant.rules()).find((entry) => entry.id === input.ruleId || entry.id.replace(/-/g, '').startsWith(wanted))
      if (!rule) throw new Error(`Geen regel ${String(input.ruleId)}.`)
      const updated = await api.assistant.updateRule(rule.id, {
        ...(typeof input.active === 'boolean' ? { active: input.active } : {}),
        ...(typeof input.description === 'string' ? { description: input.description } : {})
      })
      // A stage window switched off: back to the standard internship week.
      let rows = 0
      if (rule.type === 'stage_window' && input.active === false) rows = await applyStageWindow(api, [1, 2, 3, 4, 5], '09:00', '18:00')
      return { updated: updated.description, active: updated.active, availabilityRowsChanged: rows }
    }

    case 'apply_day_plan': {
      const day = String(input.date)
      const draft = await api.plans.draft(day)
      if (!draft.plan) throw new Error('Kon geen concept voor die dag maken.')
      const filled = await api.planner.fillDraft(draft.plan.id, day)
      await api.plans.accept(draft.plan.id)
      return {
        accepted: day,
        blocks: filled.blocks
          .filter((block) => block.kind !== 'break')
          .map((block) => `${hm(block.startMin)}–${hm(block.endMin)} ${block.taskTitle ?? block.title ?? ''}`)
      }
    }
  }
  throw new Error(`Tool zonder uitvoering: ${name}`)
}

async function weekKey(now: Date): Promise<string> {
  const { toIsoWeek } = await import('@core/util/time.js')
  return toIsoWeek(now)
}
