/**
 * What Jarvis can do, as tools over the same TimeTrackerAPI the screens use — so a task he
 * makes is a task like any other: it syncs, it plans, it reminds.
 *
 * Writing tools take `confirmed`: the model has to have asked Hidde and heard "ja" first
 * (the system prompt says so), and a call without it is refused with a sentence telling it
 * to ask. Belt and braces: the prompt is the rule, this is the lock.
 */

import type { TimeTrackerAPI } from '@core/contract/api.js'
import type { IsoDate, Priority, TaskPatch } from '@core/contract/types.js'

export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema for the input. */
  parameters: Record<string, unknown>
  writes: boolean
}

const AREAS = ['stage', 'work', 'school', 'personal']

const date = { type: 'string', description: 'Datum als YYYY-MM-DD' }
const clock = { type: 'string', description: 'Tijd als HH:MM (24 uur)' }
const confirmed = {
  type: 'boolean',
  description: 'Alleen true als Hidde deze wijziging in dit gesprek expliciet heeft bevestigd.'
}

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
      'Nieuwe taak. Vraag eerst alles uit (wat, klaar-als, gebied/project, schatting, deadline, prioriteit, bijzonderheden) en zet dat in notes.',
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
        confirmed
      },
      ['title', 'areaId', 'confirmed']
    ),
    writes: true
  },
  {
    name: 'update_task',
    description: 'Een bestaande taak aanpassen (titel, prioriteit, schatting, deadline, notitie, status).',
    parameters: object(
      {
        taskId: { type: 'string' },
        title: { type: 'string' },
        priority: { type: 'string', enum: ['high', 'medium', 'low'] },
        estimateMinutes: { type: 'integer', minimum: 0 },
        dueDate: { type: ['string', 'null'] },
        notes: { type: 'string' },
        status: { type: 'string', enum: ['open', 'done', 'blocked'] },
        confirmed
      },
      ['taskId', 'confirmed']
    ),
    writes: true
  },
  {
    name: 'create_appointment',
    description:
      'Nieuwe afspraak. Vraag eerst: wat, wanneer, duur, gebied, waar, vervoer en reistijd, belangrijk?, bijzonderheden. Reistijd maakt een reisblok; daarop tellen de vertrekmeldingen (30 en 15 min vooraf).',
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
        notes: { type: 'string', description: 'Doel, Wie, Meenemen/voorbereiden, Bijzonderheden, Belangrijk: ja/nee' },
        confirmed
      },
      ['title', 'date', 'start', 'end', 'areaId', 'confirmed']
    ),
    writes: true
  },
  {
    name: 'move_appointment',
    description: 'Een afspraak verzetten; het reisblok schuift mee.',
    parameters: object({ eventId: { type: 'string' }, date, start: clock, end: clock, confirmed }, [
      'eventId',
      'date',
      'start',
      'end',
      'confirmed'
    ]),
    writes: true
  },
  {
    name: 'propose_day_plan',
    description: 'Een voorstel voor het dagplan (niet opgeslagen): welke taken wanneer, en wat niet past.',
    parameters: object({ date }, ['date']),
    writes: false
  },
  {
    name: 'apply_day_plan',
    description: 'Het dagplan echt invullen met de planner en accepteren. Handmatig of vast geplaatste blokken blijven staan.',
    parameters: object({ date, confirmed }, ['date', 'confirmed']),
    writes: true
  },
  {
    name: 'start_timer',
    description: 'De timer starten, optioneel op een taak.',
    parameters: object({ taskId: { type: 'string' }, confirmed }, ['confirmed']),
    writes: true
  },
  {
    name: 'stop_timer',
    description: 'De lopende timer stoppen.',
    parameters: object({ confirmed }, ['confirmed']),
    writes: true
  }
]

// ------------------------------------------------------------------ run

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

type Input = Record<string, unknown>

/**
 * Runs one tool call. Returns what the model reads back — small and readable, never whole
 * rows full of ids it does not need.
 */
export async function runTool(api: TimeTrackerAPI, name: string, input: Input): Promise<unknown> {
  const spec = TOOLS.find((tool) => tool.name === name)
  if (!spec) throw new Error(`Onbekende tool: ${name}`)
  if (spec.writes && input.confirmed !== true) {
    return { refused: 'Niet uitgevoerd: vat eerst samen wat je gaat doen en vraag Hidde om bevestiging.' }
  }

  switch (name) {
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
            project: block.projectName
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

    case 'create_task': {
      let projectId: string | null = null
      if (typeof input.projectName === 'string' && input.projectName.trim()) {
        const wanted = input.projectName.trim().toLowerCase()
        const project = (await api.projects.list()).find((entry) => entry.name.toLowerCase() === wanted)
        if (!project) return { error: `Geen project "${input.projectName}". Kies uit list_projects of laat het leeg.` }
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
        notes: (input.notes as string | undefined) ?? null
      })
      return { created: task.title, taskId: task.id }
    }

    case 'update_task': {
      const patch: TaskPatch = {}
      if (typeof input.title === 'string') patch.title = input.title
      if (typeof input.priority === 'string') patch.priority = input.priority as Priority
      if (typeof input.estimateMinutes === 'number') patch.estimateMin = input.estimateMinutes
      if (input.dueDate !== undefined) patch.dueDate = input.dueDate as string | null
      if (typeof input.notes === 'string') patch.notes = input.notes
      if (input.status === 'done') {
        const task = await api.tasks.complete(String(input.taskId), true)
        return { done: task.title }
      }
      if (typeof input.status === 'string') patch.status = input.status as TaskPatch['status']
      const task = await api.tasks.update(String(input.taskId), patch)
      return { updated: task.title }
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
        countsAsWorked: false
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
          : `Melding om ${hm(minuteOf(String(input.start)) - 15)}`
      }
    }

    case 'move_appointment': {
      const day = String(input.date)
      const moved = await api.calendar.move(String(input.eventId), at(day, String(input.start)), at(day, String(input.end)))
      return { moved: moved.title, to: `${day} ${input.start}–${input.end}` }
    }

    case 'propose_day_plan': {
      const proposal = await api.planner.proposeDay(String(input.date))
      return {
        blocks: proposal.blocks.map((block) => ({
          from: hm(block.startMin),
          to: hm(block.endMin),
          taskId: block.taskId,
          kind: block.kind
        })),
        unplaced: proposal.unplaced,
        plannedMinutes: proposal.plannedMin,
        availableMinutes: proposal.availableMin
      }
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

    case 'start_timer': {
      const run = await api.tracking.startRun((input.taskId as string | undefined) ?? null)
      return { started: true, at: clockOf(run.startedAt) }
    }

    case 'stop_timer': {
      await api.tracking.stopRun()
      return { stopped: true }
    }
  }
  throw new Error(`Tool zonder uitvoering: ${name}`)
}

async function weekKey(now: Date): Promise<string> {
  const { toIsoWeek } = await import('@core/util/time.js')
  return toIsoWeek(now)
}
