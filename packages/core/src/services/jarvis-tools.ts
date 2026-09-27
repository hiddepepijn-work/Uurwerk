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
import type { IsoDate, Priority, TaskPatch } from '@core/contract/types.js'

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

const date = { type: 'string', description: 'Datum als YYYY-MM-DD' }
const clock = { type: 'string', description: 'Tijd als HH:MM (24 uur)' }
const PROPOSAL = ' Maakt een voorstel; pas na Hiddes ja uitvoeren met confirm.'

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
})

export const TOOLS: ToolSpec[] = [
  {
    name: 'get_now',
    description: 'De huidige datum, tijd, weekdag en ISO-week. Gebruik dit voor je iets over "vandaag" of "morgen" zegt.',
    parameters: object({}),
    writes: false
  },
  {
    name: 'get_agenda',
    description:
      'De agenda van een of meer dagen: geplande blokken (taken, pauzes) én afspraken met hun notitie, locatie en reisblokken. Maximaal 21 dagen.',
    parameters: object({ from: date, to: date }, ['from', 'to']),
    writes: false
  },
  {
    name: 'list_tasks',
    description:
      'Taken met prioriteit, gebied, project, schatting, gelogde tijd, deadline en notitie. Standaard alleen open taken.',
    parameters: object({
      status: { type: 'string', enum: ['active', 'open', 'done', 'blocked'], description: 'Standaard active' },
      search: { type: 'string' }
    }),
    writes: false
  },
  {
    name: 'list_projects',
    description: 'Alle projecten met hun gebied, voor het koppelen van een nieuwe taak.',
    parameters: object({}),
    writes: false
  },
  {
    name: 'day_review',
    description:
      'Hoe een dag ging: welke geplande taken af zijn en welke niet, en de gewerkte minuten per gebied (stage, work, school, personal).',
    parameters: object({ date }, ['date']),
    writes: false
  },
  {
    name: 'create_task',
    description:
      'Nieuwe taak. Vraag eerst alles uit (wat, klaar-als, gebied/project, schatting, deadline, prioriteit, bijzonderheden) en zet dat in notes.' +
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
        }
      },
      ['title', 'areaId']
    ),
    writes: true,
    proposes: true
  },
  {
    name: 'update_task',
    description: 'Een bestaande taak aanpassen (titel, prioriteit, schatting, deadline, notitie, status).' + PROPOSAL,
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
    description:
      'Een taak op een vast tijdstip in de planning zetten (een blok, geen afspraak). Taken plan je altijd hiermee of met plan_range, nooit met create_appointment. Weigert overlap met afspraken en met blokken die met de hand zijn gezet; blokken van de planner op die plek maken plaats.' +
      PROPOSAL,
    parameters: object({ taskId: { type: 'string' }, date, start: clock, end: clock }, ['taskId', 'date', 'start', 'end']),
    writes: true,
    proposes: true
  },
  {
    name: 'plan_range',
    description:
      'De planner opnieuw laten plannen van een dag tot en met een dag: open taken in de vrije tijd, met de harde regels (stage alleen ma-vr binnen de stage-uren, pauzes). Vervangt alleen wat de planner eerder zette; afspraken en met de hand gezette blokken blijven. Voor "plan opnieuw tot …".' +
      PROPOSAL,
    parameters: object({ from: date, to: date }, ['from', 'to']),
    writes: true,
    proposes: true
  },
  {
    name: 'clear_planning',
    description:
      'Wist wat de planner en jij (Jarvis) hebben ingepland van een dag tot en met een dag, zonder opnieuw te plannen. Afspraken en wat Hidde zelf zette blijven. Voor "haal de planning weg".' +
      PROPOSAL,
    parameters: object({ from: date, to: date }, ['from', 'to']),
    writes: true,
    proposes: true
  },
  {
    name: 'create_appointment',
    description:
      'Nieuwe afspraak: alleen voor iets met een vaste tijd met iemand of ergens (geen taken). Vraag eerst: wat, wanneer, duur, gebied, waar, vervoer en reistijd, belangrijk?, bijzonderheden. Reistijd maakt een reisblok; daarop tellen de vertrekmeldingen (30 en 15 min vooraf).' +
      PROPOSAL,
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
    description: 'Een afspraak verzetten; het reisblok schuift mee.' + PROPOSAL,
    parameters: object({ eventId: { type: 'string' }, date, start: clock, end: clock }, ['eventId', 'date', 'start', 'end']),
    writes: true,
    proposes: true
  },
  {
    name: 'delete_appointment',
    description: 'Een afspraak verwijderen, met zijn reisblokken.' + PROPOSAL,
    parameters: object({ eventId: { type: 'string' } }, ['eventId']),
    writes: true,
    proposes: true
  },
  {
    name: 'propose_day_plan',
    description: 'Een voorstel voor het dagplan (niet opgeslagen): welke taken wanneer, en wat niet past.',
    parameters: object({ date }, ['date']),
    writes: false
  },
  {
    name: 'apply_day_plan',
    description: 'Het dagplan van één dag laten invullen door de planner. Handmatig of vast geplaatste blokken blijven staan.' + PROPOSAL,
    parameters: object({ date }, ['date']),
    writes: true,
    proposes: true
  },
  {
    name: 'confirm',
    description:
      'Voert de openstaande voorstellen uit, na een duidelijk ja van Hidde. Zonder pendingIds: alle openstaande. Geeft de echte uitkomst uit de database terug; vertel Hidde precies die, ook wat mislukte.',
    parameters: object({ pendingIds: { type: 'array', items: { type: 'string' } } }),
    writes: true
  },
  {
    name: 'cancel',
    description: 'Laat openstaande voorstellen vallen (Hidde zei nee of wil iets anders). Zonder pendingIds: alle.',
    parameters: object({ pendingIds: { type: 'array', items: { type: 'string' } } }),
    writes: false
  },
  {
    name: 'start_timer',
    description: 'De timer starten, optioneel op een taak.' + PROPOSAL,
    parameters: object({ taskId: { type: 'string' } }),
    writes: true,
    proposes: true
  },
  {
    name: 'stop_timer',
    description: 'De lopende timer stoppen.' + PROPOSAL,
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
      return `Nieuwe taak "${String(input.title)}" (${String(input.areaId)}${typeof input.estimateMinutes === 'number' ? `, ${input.estimateMinutes} min` : ''}${input.dueDate ? `, deadline ${String(input.dueDate)}` : ''})`
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
    case 'start_timer':
      return input.taskId ? `Timer starten op "${await taskTitle(input.taskId)}"` : 'Timer starten'
    case 'stop_timer':
      return 'Timer stoppen'
  }
  return name
}

/** Checks what can be checked before the "ja", so a proposal that cannot work is not asked. */
async function precheck(api: TimeTrackerAPI, name: string, input: Input): Promise<void> {
  if (name === 'schedule_task') await slotFor(api, input)
  if (name === 'plan_range' || name === 'clear_planning') daysBetween(fromToday(String(input.from)), String(input.to))
  if (['create_appointment', 'move_appointment'].includes(name)) {
    if (minuteOf(String(input.end)) <= minuteOf(String(input.start))) throw new Error('Het einde ligt voor het begin.')
  }
}

async function propose(api: TimeTrackerAPI, name: string, input: Input): Promise<unknown> {
  try {
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

  const executed: Array<{ summary: string; result: unknown }> = []
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
      executed.push({ summary: proposal.summary, result })
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
    say: 'Vertel Hidde precies dit: wat gelukt is (met de aantallen hierboven) en wat mislukte. Zeg niets dat hier niet staat.'
  }
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
): Promise<{ day: IsoDate; startMin: number; endMin: number; replaces: Array<{ id: string; title: string }> }> {
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
  const replaces: Array<{ id: string; title: string }> = []
  for (const block of plan.blocks) {
    if (!overlaps(block.startMin, block.endMin)) continue
    const title = block.taskTitle ?? block.title ?? block.kind
    if (block.source === 'planner' && !block.locked && !block.fixed) replaces.push({ id: block.id, title })
    else walls.push(`${title} ${hm(block.startMin)}–${hm(block.endMin)}`)
  }
  const events = await api.calendar.eventsInRange(dayStart(day), dayStart(day) + 86_400_000)
  for (const event of events) {
    if (event.cancelled || event.allDay) continue
    const from = Math.round((event.startsAt - dayStart(day)) / 60_000)
    const to = Math.round((event.endsAt - dayStart(day)) / 60_000)
    if (overlaps(from, to)) walls.push(`${event.title} ${clockOf(event.startsAt)}–${clockOf(event.endsAt)}`)
  }
  if (walls.length > 0) throw new Error(`Overlapt met ${walls.join(', ')}`)
  return { day, startMin, endMin, replaces }
}

/** The planner's own blocks on a day: what plan_range replaces and clear_planning removes. */
const plannerBlocks = async (api: TimeTrackerAPI, day: IsoDate) =>
  (await api.plans.day(day)).blocks.filter((block) => block.source === 'planner' && !block.locked && !block.fixed)

/** Does the work of a confirmed proposal, and reads the result back from the database. */
async function execute(api: TimeTrackerAPI, name: string, input: Input): Promise<unknown> {
  switch (name) {
    case 'create_task': {
      let projectId: string | null = null
      if (typeof input.projectName === 'string' && input.projectName.trim()) {
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
      return { created: task.title, taskId: task.id, focus: task.focusMode }
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
        placed: `${slot.day} ${hm(slot.startMin)}–${hm(slot.endMin)}`,
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
      await api.calendar.deleteEvent(String(input.eventId))
      return { deleted: true }
    }

    case 'start_timer': {
      const run = await api.tracking.startRun((input.taskId as string | undefined) ?? null)
      return { started: true, at: clockOf(run.startedAt) }
    }

    case 'stop_timer': {
      await api.tracking.stopRun()
      return { stopped: true }
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
