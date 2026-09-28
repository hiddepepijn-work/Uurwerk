/**
 * Jarvis benchmark: the same conversations with OpenAI Realtime (gpt-realtime-2.1-mini) and
 * Gemini Live, scored on what they did (hard checks on the database), how they said it (a
 * blind judge), how fast, and what it cost.
 *
 *   npm run bench:jarvis                          both models, every scenario once
 *   ONLY=openai | ONLY=gemini | ONLY=openai-full  some models (comma list); openai-full is
 *                                                gpt-realtime-2.1 (not mini), ~4× the price
 *   SCENARIOS=D1,B5                               a few scenarios
 *   BUDGET_OPENAI=1.05 BUDGET_GEMINI=2.70 BUDGET_OPENAI_FULL=0.85
 *                                                stop a model when its spend reaches this ($)
 *
 * Every scenario starts on a fresh copy of this machine's database, with its own setup on
 * top (an appointment in the way, an overdue task), so both models see exactly the same
 * day. The real database is never touched. Spoken turns reuse cached TTS clips.
 *
 * Needs OPENAI_API_KEY and GEMINI_API_KEY in .env.local.
 */

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GoogleGenAI, type LiveServerMessage } from '@google/genai'

import { createBackend } from '@backend/create.js'
import { installHost, unavailable, type Host } from '@backend/host.js'
import { buildImplementation } from '@backend/implementation.js'
import type { JarvisLiveUsage, TimeTrackerAPI } from '@core/contract/api.js'
import { runTool } from '@core/services/jarvis-tools.js'

import { MOMENT, SYSTEM } from '../packages/server/app/jarvis/index.js'
import { instructionParts, liveSession, openaiSession, usageUsd } from '../packages/server/app/jarvis/live.js'
import { ClaudeBrain, OpenAIBrain } from '../packages/server/app/jarvis/brain-others.js'
import { Brain, type ThinkingBrain } from '../packages/server/app/jarvis/brain.js'
import { speakGemini } from '../packages/server/app/jarvis/speech.js'

// ------------------------------------------------------------------ setup

function key(name: string): string {
  if (process.env[name]) return process.env[name]!.trim()
  const line = existsSync('.env.local')
    ? readFileSync('.env.local', 'utf8').split(/\r?\n/).find((entry) => entry.startsWith(`${name}=`))
    : undefined
  if (line) return line.slice(name.length + 1).trim()
  throw new Error(`Geen ${name}: zet hem in .env.local.`)
}
const GEMINI_KEY = key('GEMINI_API_KEY')
const OPENAI_KEY = key('OPENAI_API_KEY')

const work = mkdtempSync(join(tmpdir(), 'uurwerk-bench-'))
const appData = process.env.APPDATA ?? join(process.env.USERPROFILE ?? '.', 'AppData', 'Roaming')
const realDb = join(appData, 'uurwerk', 'uurwerk', 'app.db')
// One snapshot of the real database; every scenario gets its own copy of it.
const snapshotDb = join(work, 'snapshot.db')
copyFileSync(realDb, snapshotDb)

installHost({
  emit: () => undefined,
  secrets: { get: () => null, set: () => undefined, has: () => false },
  reportDir: () => work,
  openPath: unavailable('open'),
  openExternal: unavailable('open'),
  showItemInFolder: () => undefined,
  capture: { markNow: unavailable('capture'), buildTimelapse: unavailable('timelapse') },
  startup: { getLoginItemStatus: unavailable('startup'), setAutoLaunch: unavailable('startup') },
  window: { minimizeToTray: unavailable('w'), closeQuickAdd: unavailable('w'), quit: unavailable('w') },
  relaunch: unavailable('relaunch'),
  sync: { status: unavailable('s'), pair: unavailable('s'), now: unavailable('s'), unpair: unavailable('s') },
  fileFor: (artifact) => artifact.path
} satisfies Host)

let copies = 0
function freshApi(): TimeTrackerAPI {
  copies += 1
  const path = join(work, `run-${copies}.db`)
  copyFileSync(snapshotDb, path)
  return buildImplementation(createBackend(path)) as unknown as TimeTrackerAPI
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// ------------------------------------------------------------------ dates

const ymd = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const inDays = (days: number): string => ymd(new Date(Date.now() + days * 86_400_000))
/** 1 = Monday … 7 = Sunday; the next one after today. */
function nextWeekday(weekday: number): string {
  const now = new Date()
  const today = ((now.getDay() + 6) % 7) + 1
  return inDays(((weekday - today + 7) % 7) || 7)
}
/** That weekday in next week (Monday to Sunday). */
function weekdayNextWeek(weekday: number): string {
  const now = new Date()
  const today = ((now.getDay() + 6) % 7) + 1
  return inDays(7 - today + weekday)
}
const dayRange = (day: string): [number, number] => {
  const start = new Date(`${day}T00:00:00`).getTime()
  return [start, start + 86_400_000]
}

// ------------------------------------------------------------ lookups

async function blocksOn(api: TimeTrackerAPI, day: string, title: RegExp) {
  return (await api.plans.day(day)).blocks.filter((block) => title.test(block.taskTitle ?? block.title ?? ''))
}
async function eventsOn(api: TimeTrackerAPI, day: string, title: RegExp) {
  const [from, to] = dayRange(day)
  return (await api.calendar.eventsInRange(from, to)).filter((event) => title.test(event.title))
}
async function taskNamed(api: TimeTrackerAPI, title: RegExp) {
  const all = [...(await api.tasks.list({ status: 'active' })), ...(await api.tasks.list({ status: 'done' }))]
  return all.find((task) => title.test(task.title)) ?? null
}
const clockOf = (ms: number): string => {
  const date = new Date(ms)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** Sets up an appointment the way Jarvis would: propose, confirm. */
async function appointment(api: TimeTrackerAPI, title: string, date: string, start: string, end: string, areaId = 'personal'): Promise<void> {
  const proposed = (await runTool(api, 'create_appointment', { title, date, start, end, areaId, travelMinutes: 0 })) as { pendingId?: string; error?: string }
  if (!proposed.pendingId) throw new Error(`setup: ${proposed.error ?? 'geen voorstel'}`)
  await runTool(api, 'confirm', { pendingIds: [proposed.pendingId] })
}

// -------------------------------------------------------------- scenarios

interface Check {
  /** After which turn (0-based) this is checked. */
  after: number
  name: string
  test: (api: TimeTrackerAPI, turns: Turn[]) => Promise<boolean>
}

interface Scenario {
  id: string
  category: 'dagelijks' | 'verder' | 'challenge'
  /** Challenge set: the kind of problem, to score per kind. */
  family?: string
  title: string
  /** What a good answer does; the judge scores against this. */
  expect: string
  opening?: 'morning' | 'evening'
  turns: Array<{ text: string; spoken?: boolean }>
  setup?: (api: TimeTrackerAPI) => Promise<void>
  /** Facts the judge needs (computed from the copy, before the conversation). */
  truth?: (api: TimeTrackerAPI) => Promise<string>
  checks?: Check[]
  /** Tool calls a sensible run needs at most; more counts as waste. */
  toolBudget?: number
}

const snapshotTruth = (from?: string, to?: string) => async (api: TimeTrackerAPI): Promise<string> =>
  JSON.stringify(await runTool(api, 'get_snapshot', from ? { from, to } : {})).slice(0, 7000)

const TOMORROW = inDays(1)
const THURSDAY = nextWeekday(4)
const FRIDAY = nextWeekday(5)
const NEXT_THURSDAY = weekdayNextWeekday()
function weekdayNextWeekday(): string {
  return weekdayNextWeek(4)
}

const SCENARIOS: Scenario[] = [
  // ------------------------------------------------------------ daily use
  {
    id: 'D1',
    category: 'dagelijks',
    title: 'Planning morgen (gesproken)',
    expect: 'Noemt wat er morgen op de planning en in de agenda staat, klopt met de feiten, kort genoeg om uit te spreken.',
    turns: [{ text: 'Wat staat er morgen op de planning?', spoken: true }],
    truth: snapshotTruth()
  },
  {
    id: 'D2',
    category: 'dagelijks',
    title: 'Wat moet ik vandaag nog (gesproken)',
    expect: 'Noemt wat vandaag nog open staat of gepland is, inclusief te late taken, klopt met de feiten.',
    turns: [{ text: 'Wat moet ik vandaag nog doen?', spoken: true }],
    truth: snapshotTruth()
  },
  {
    id: 'D3',
    category: 'dagelijks',
    title: 'Nieuwe taak op een tijd, dan ja (gesproken)',
    expect: 'Stelt voor: taak "kast fixen" morgen 20:00–21:00, vraagt bevestiging, voert pas na ja uit en zegt dat het staat.',
    turns: [
      { text: 'Zet morgenavond om acht uur een uur kast fixen erin.', spoken: true },
      { text: 'Ja, doe maar.', spoken: true }
    ],
    checks: [
      { after: 0, name: 'nog niets geschreven vóór ja', test: async (api) => (await blocksOn(api, TOMORROW, /kast/i)).length === 0 },
      {
        after: 1,
        name: 'blok morgen 20:00–21:00',
        test: async (api) => (await blocksOn(api, TOMORROW, /kast/i)).some((block) => block.startMin === 20 * 60 && block.endMin === 21 * 60)
      }
    ],
    toolBudget: 3
  },
  {
    id: 'D4',
    category: 'dagelijks',
    title: 'Afspraak, geen taak',
    expect: `Maakt een AFSPRAAK (geen taak) bij de tandarts op donderdag ${THURSDAY} 15:00–15:30, vraagt bevestiging, voert uit na ja.`,
    // Where and how far are in it: the brief asks for both, and a script cannot answer back.
    turns: [{ text: 'Ik heb donderdag om drie uur een afspraak bij de tandarts in Zevenaar, tien minuten rijden, duurt een half uur.' }, { text: 'Ja.' }],
    checks: [
      {
        after: 1,
        name: 'afspraak do 15:00–15:30',
        test: async (api) => (await eventsOn(api, THURSDAY, /tandarts/i)).some((event) => clockOf(event.startsAt) === '15:00' && clockOf(event.endsAt) === '15:30')
      },
      { after: 1, name: 'geen taak "tandarts"', test: async (api) => (await taskNamed(api, /tandarts/i)) === null }
    ],
    toolBudget: 3
  },
  {
    id: 'D5',
    category: 'dagelijks',
    title: 'Afspraak verzetten',
    expect: 'Verzet de kapper van morgen 16:00 naar 17:00–17:30 na bevestiging.',
    setup: (api) => appointment(api, 'Kapper', TOMORROW, '16:00', '16:30'),
    turns: [{ text: 'Kan de kapper van morgen een uur later?' }, { text: 'Ja graag.' }],
    checks: [
      {
        after: 1,
        name: 'kapper om 17:00',
        test: async (api) => (await eventsOn(api, TOMORROW, /kapper/i)).some((event) => clockOf(event.startsAt) === '17:00')
      }
    ],
    toolBudget: 4
  },
  {
    id: 'D6',
    category: 'dagelijks',
    title: 'Taak afvinken',
    expect: 'Zet de taak "Boodschappen doen" op af (na bevestiging) en zegt het.',
    setup: async (api) => {
      await api.tasks.create({ title: 'Boodschappen doen', areaId: 'personal', estimateMin: 30 })
    },
    turns: [{ text: 'De boodschappen heb ik net gedaan.' }, { text: 'Ja.' }],
    checks: [
      {
        after: 1,
        name: 'taak af',
        test: async (api) => {
          const task = await taskNamed(api, /boodschappen/i)
          return !!task && (task.status as string) === 'done'
        }
      }
    ],
    toolBudget: 3
  },
  {
    id: 'D7',
    category: 'dagelijks',
    title: 'Timer starten',
    expect: 'Start (na bevestiging) een timer op de taak "Kast fixen".',
    setup: async (api) => {
      await api.tasks.create({ title: 'Kast fixen', areaId: 'personal', estimateMin: 60 })
    },
    turns: [{ text: 'Start de timer op kast fixen.' }, { text: 'Ja.' }],
    checks: [
      {
        after: 1,
        name: 'timer loopt op kast fixen',
        test: async (api) => {
          const task = await taskNamed(api, /kast fixen/i)
          const segment = await api.tracking.currentSegment()
          return !!task && segment?.taskId === task.id
        }
      }
    ],
    toolBudget: 3
  },

  // ------------------------------------------------- beyond the basics
  {
    id: 'B1',
    category: 'verder',
    title: 'Avond vullen rond een training',
    expect:
      'Zet Werkstuk afmaken (60 min), Fiets repareren (30 min) en Mail opruimen (20 min) morgenavond na de stage in, niet tijdens de voetbaltraining 19:00–20:00, stelt het als één voorstel voor en voert uit na ja.',
    setup: async (api) => {
      // Names the real database does not have: with its own 'Regelen financiën' (120 min) the
      // evening really was too full, and the judge took that for making things up.
      await api.tasks.create({ title: 'Fiets repareren', areaId: 'personal', estimateMin: 30 })
      await api.tasks.create({ title: 'Mail opruimen', areaId: 'personal', estimateMin: 20 })
      // Its own task: the real 'BO afmaken' may be done by now.
      await api.tasks.create({ title: 'Werkstuk afmaken', areaId: 'school', estimateMin: 60 })
      await appointment(api, 'Voetbaltraining', TOMORROW, '19:00', '20:00')
    },
    turns: [
      { text: 'Plan morgenavond na mijn stage werkstuk afmaken, fiets repareren en mail opruimen in. Niet tijdens de training.' },
      { text: 'Ja, prima.' }
    ],
    checks: [
      {
        after: 1,
        name: 'drie blokken na 17:00, niet in 19–20',
        test: async (api) => {
          const blocks = [
            ...(await blocksOn(api, TOMORROW, /werkstuk afmaken/i)),
            ...(await blocksOn(api, TOMORROW, /fiets/i)),
            ...(await blocksOn(api, TOMORROW, /mail opruimen/i))
          ].filter((block) => block.startMin >= 17 * 60)
          const clash = blocks.some((block) => block.startMin < 20 * 60 && block.endMin > 19 * 60)
          return new Set(blocks.map((block) => block.taskTitle)).size === 3 && !clash
        }
      }
    ],
    toolBudget: 5
  },
  {
    id: 'B2',
    category: 'verder',
    title: 'Botsing met een afspraak',
    expect: 'Ziet dat morgen 10:00–11:00 al een overleg met Margriet staat, zet de taak daar niet overheen en stelt een andere tijd voor of vraagt wat Hidde wil.',
    setup: async (api) => {
      await appointment(api, 'Overleg Margriet', TOMORROW, '10:00', '11:00', 'stage')
      await api.tasks.create({ title: 'Kast fixen', areaId: 'personal', estimateMin: 60 })
    },
    turns: [{ text: 'Zet morgen om tien uur een uur kast fixen erin.' }],
    checks: [
      {
        after: 0,
        name: 'geen blok over het overleg',
        test: async (api) => (await blocksOn(api, TOMORROW, /kast/i)).every((block) => !(block.startMin < 11 * 60 && block.endMin > 10 * 60))
      }
    ],
    toolBudget: 3
  },
  {
    id: 'B3',
    category: 'verder',
    title: 'Vaste regel',
    expect: 'Maakt (na bevestiging) een vaste regel: voortaan geen stage op woensdag.',
    turns: [{ text: 'Voortaan wil ik op woensdag geen stage meer doen.' }, { text: 'Ja.' }],
    checks: [
      {
        after: 1,
        name: 'regel over woensdag',
        test: async (api) =>
          (await api.assistant.rules()).some(
            (rule) =>
              rule.active &&
              (/woensdag/i.test(rule.description) ||
                (rule.type === 'stage_window' && Array.isArray(rule.config.days) && !(rule.config.days as unknown[]).map(String).some((day) => /^(3|wed|wo)/i.test(day))))
          )
      }
    ],
    toolBudget: 3
  },
  {
    id: 'B4',
    category: 'verder',
    title: 'Vaag verzoek: doorvragen',
    expect: 'Er zijn meerdere schooltaken; vraagt welke bedoeld wordt en wanneer, in plaats van zelf iets te kiezen en in te plannen.',
    setup: async (api) => {
      await api.tasks.create({ title: 'Verslag statistiek', areaId: 'school', estimateMin: 90 })
      await api.tasks.create({ title: 'Presentatie GIS voorbereiden', areaId: 'school', estimateMin: 60 })
    },
    turns: [{ text: 'Zet dat ding van school ergens deze week.' }],
    checks: [
      { after: 0, name: 'geen voorstel zonder te weten welke', test: async (api) => (await api.assistant.pendingProposals()).length === 0 }
    ],
    toolBudget: 2
  },
  {
    id: 'B5',
    category: 'verder',
    title: 'Geheugen: "die van net"',
    expect: 'Onthoudt de net ingeplande taak en verzet die (na tweede ja) naar 22:00–22:30.',
    turns: [
      { text: "Zet morgen om negen uur 's avonds een half uur mail beantwoorden erin." },
      { text: 'Ja.' },
      { text: 'Doe die van net toch maar een uur later.' },
      { text: 'Ja.' }
    ],
    checks: [
      {
        after: 3,
        name: 'mail om 22:00, niet meer om 21:00',
        test: async (api) => {
          const blocks = await blocksOn(api, TOMORROW, /mail/i)
          return blocks.some((block) => block.startMin === 22 * 60) && !blocks.some((block) => block.startMin === 21 * 60)
        }
      }
    ],
    toolBudget: 7
  },
  {
    id: 'B6',
    category: 'verder',
    title: 'Niet verzinnen',
    expect: 'Er is geen afspraak met een notaris. Zegt dat eerlijk (eventueel na zoeken), verzint geen tijd.',
    turns: [{ text: 'Hoe laat was mijn afspraak met de notaris ook alweer?' }],
    toolBudget: 2
  },
  {
    id: 'B7',
    category: 'verder',
    title: 'Datum verder weg',
    expect: `Weet dat "volgende week donderdag" ${NEXT_THURSDAY} is, zoekt die dag op en noemt de verjaardag van oma om 18:00.`,
    setup: (api) => appointment(api, 'Verjaardag oma', NEXT_THURSDAY, '18:00', '21:00'),
    turns: [{ text: 'Wat heb ik volgende week donderdag?' }],
    toolBudget: 2
  },
  {
    id: 'B8',
    category: 'verder',
    title: 'Proactief: deadline in gevaar',
    expect:
      'Beschrijft morgen, en wijst uit zichzelf op de scriptie-deadline van morgen (3 uur werk, nog niet ingepland) en stelt voor die ergens in te plannen.',
    setup: async (api) => {
      await api.tasks.create({ title: 'Scriptiehoofdstuk inleveren', areaId: 'school', estimateMin: 180, priority: 'high', dueDate: TOMORROW })
    },
    turns: [{ text: 'Hoe ziet morgen eruit?' }],
    truth: snapshotTruth(),
    toolBudget: 2
  },
  {
    id: 'B9',
    category: 'verder',
    title: 'Avondronde',
    expect:
      'Doet de dagafsluiting: wat af is en wat niet (streng), en vraagt hoe het ging met opruimen achter zichzelf aan / structuur. Eén vraag tegelijk. Reageert daarna zinnig op het antwoord.',
    opening: 'evening',
    turns: [{ text: 'Ging wel. Keuken heb ik niet opgeruimd, de rest wel.' }],
    toolBudget: 4
  },
  {
    id: 'B10',
    category: 'verder',
    title: 'Rekenen over de week',
    expect: 'Noemt correct hoeveel uur stage er van nu tot en met zondag nog gepland staat.',
    turns: [{ text: 'Hoeveel uur stage staat er deze week nog gepland?' }],
    truth: async (api) => {
      const now = new Date()
      const today = ((now.getDay() + 6) % 7) + 1
      const nowMin = now.getHours() * 60 + now.getMinutes()
      let total = 0
      const lines: string[] = []
      for (let offset = 0; offset <= 7 - today; offset += 1) {
        const day = inDays(offset)
        const blocks = (await api.plans.day(day)).blocks.filter((block) => block.areaId === 'stage' && block.kind === 'task')
        let dayMin = 0
        for (const block of blocks) {
          const start = offset === 0 ? Math.max(block.startMin, nowMin) : block.startMin
          if (block.endMin > start) dayMin += block.endMin - start
        }
        total += dayMin
        lines.push(`${day}: ${(dayMin / 60).toFixed(2)} uur`)
      }
      return `Stageblokken vanaf nu t/m zondag: ${(total / 60).toFixed(2)} uur in totaal. Per dag: ${lines.join('; ')}. (Een antwoord dat de hele dag van vandaag meetelt, of afrondt op het halve uur, is ook goed.)`
    },
    toolBudget: 3
  },
  {
    id: 'B11',
    category: 'verder',
    title: 'Toch niet',
    expect: 'Stelt hardlopen morgen 07:00 voor; na "nee laat maar" doet hij niets en laat het voorstel vallen.',
    turns: [{ text: "Zet morgen om zeven uur 's ochtends een half uur hardlopen erin." }, { text: 'Nee, laat maar eigenlijk.' }],
    checks: [
      { after: 1, name: 'niets ingepland', test: async (api) => (await blocksOn(api, TOMORROW, /hardlopen/i)).length === 0 && (await taskNamed(api, /hardlopen/i)) === null }
    ],
    toolBudget: 3
  },
  {
    id: 'B12',
    category: 'verder',
    title: 'Twee dingen in één zin',
    expect: `Voegt taak "band plakken" toe én maakt een afspraak "Huisarts" op vrijdag ${FRIDAY} 14:00–14:20; één bevestiging, beide uitgevoerd.`,
    turns: [
      { text: 'Voeg een taak band plakken toe, een half uurtje, en ik heb vrijdag om twee uur de huisarts, twintig minuten, hier in Zevenaar om de hoek.' },
      { text: 'Ja, allebei.' }
    ],
    checks: [
      { after: 1, name: 'taak band plakken', test: async (api) => (await taskNamed(api, /band/i)) !== null },
      {
        after: 1,
        name: 'afspraak huisarts vr 14:00',
        test: async (api) => (await eventsOn(api, FRIDAY, /huisarts/i)).some((event) => clockOf(event.startsAt) === '14:00')
      }
    ],
    toolBudget: 4
  }
]

// ------------------------------------------------------- challenge set
//
// SET=challenge: eight kinds of problem, five variants each, made from templates. Other days,
// other times, other words, and made-up tasks the real database does not have. None of these
// were used to tune the prompt, so they measure the model rather than our fixes for it.

const DAY_NAMES = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag']
const dayName = (day: string): string => DAY_NAMES[new Date(`${day}T12:00:00`).getDay()]!
const replyHas = (pattern: RegExp) => async (_api: TimeTrackerAPI, turns: Turn[]) => turns.some((turn) => pattern.test(turn.reply))
const at = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5))

function eveningAround(variant: string, v: {
  day: string
  appointment: [string, string, string]
  tasks: Array<[string, number]>
  from: string
  say: string
}): Scenario {
  const [title, start, end] = v.appointment
  return {
    id: `C1${variant}`,
    family: 'avond rond een afspraak',
    category: 'challenge',
    title: `Avond vullen rond ${title.toLowerCase()}`,
    expect: `Zet ${v.tasks.map(([task, minutes]) => `${task} (${minutes} min)`).join(', ')} op ${v.day} vanaf ${v.from} in, elk met die duur, niet tijdens ${title} ${start}–${end}; één voorstel, uitgevoerd na ja.`,
    setup: async (api) => {
      for (const [task, minutes] of v.tasks) await api.tasks.create({ title: task, areaId: 'personal', estimateMin: minutes })
      await appointment(api, title, v.day, start, end)
    },
    turns: [{ text: v.say }, { text: 'Ja, prima.' }],
    truth: snapshotTruth(v.day, v.day),
    checks: [
      {
        after: 1,
        name: 'alle taken ingepland, eigen duur, niet over de afspraak',
        test: async (api) => {
          for (const [task, minutes] of v.tasks) {
            const blocks = (await blocksOn(api, v.day, new RegExp(task, 'i'))).filter((block) => block.startMin >= at(v.from))
            if (blocks.length !== 1) return false
            const block = blocks[0]!
            if (block.endMin - block.startMin !== minutes) return false
            if (block.startMin < at(end) && block.endMin > at(start)) return false
          }
          return true
        }
      }
    ],
    toolBudget: 5
  }
}

function clash(variant: string, v: { day: string; appointment: [string, string, string]; task: [string, number]; say: string }): Scenario {
  const [title, start, end] = v.appointment
  const [task, minutes] = v.task
  return {
    id: `C2${variant}`,
    family: 'botsing',
    category: 'challenge',
    title: `Botsing met ${title.toLowerCase()}`,
    expect: `Ziet dat ${title} op ${v.day} ${start}–${end} in de weg zit, zet ${task} daar niet overheen en stelt een andere tijd voor; na ja staat het op die andere tijd.`,
    setup: async (api) => {
      await api.tasks.create({ title: task, areaId: 'personal', estimateMin: minutes })
      await appointment(api, title, v.day, start, end)
    },
    turns: [{ text: v.say }, { text: 'Ja, doe maar wat jij voorstelt.' }],
    truth: snapshotTruth(v.day, v.day),
    checks: [
      {
        after: 1,
        name: 'niets over de afspraak heen',
        test: async (api) => (await blocksOn(api, v.day, new RegExp(task, 'i'))).every((block) => !(block.startMin < at(end) && block.endMin > at(start)))
      }
    ],
    toolBudget: 4
  }
}

function relativeDate(variant: string, v: { day: string; event: [string, string, string]; phrase: string; keyword: RegExp }): Scenario {
  const [title, start, end] = v.event
  return {
    id: `C3${variant}`,
    family: 'datum',
    category: 'challenge',
    title: `"${v.phrase}"`,
    expect: `Weet dat "${v.phrase}" ${dayName(v.day)} ${v.day} is en noemt ${title} om ${start}.`,
    setup: (api) => appointment(api, title, v.day, start, end),
    turns: [{ text: `Wat heb ik ${v.phrase}?` }],
    // The whole day, not only the appointment: naming the stage blocks around it is right.
    truth: async (api) => `${dayName(v.day)} ${v.day}: ${await snapshotTruth(v.day, v.day)(api)}`,
    checks: [{ after: 0, name: 'noemt de afspraak', test: replyHas(v.keyword) }],
    toolBudget: 2
  }
}

function memory(variant: string, v: { day: string; task: string; start: string; minutes: number; move: string; to: string; say: string }): Scenario {
  const pattern = new RegExp(v.task.split(' ')[0]!, 'i')
  return {
    id: `C4${variant}`,
    family: 'geheugen',
    category: 'challenge',
    title: `"${v.move}"`,
    expect: `Zet ${v.task} op ${v.day} om ${v.start} (${v.minutes} min) na ja, begrijpt dan "${v.move}" als die taak en verzet hem na het tweede ja naar ${v.to}; het oude blok is weg.`,
    turns: [{ text: v.say }, { text: 'Ja.' }, { text: v.move }, { text: 'Ja.' }],
    checks: [
      {
        after: 3,
        name: `alleen nog om ${v.to}`,
        test: async (api) => {
          const blocks = await blocksOn(api, v.day, pattern)
          return blocks.length === 1 && blocks[0]!.startMin === at(v.to)
        }
      }
    ],
    toolBudget: 7
  }
}

function twoInOne(variant: string, v: { say: string; task: RegExp; day: string; event: RegExp; start: string }): Scenario {
  return {
    id: `C5${variant}`,
    family: 'twee in één zin',
    category: 'challenge',
    title: 'Taak en afspraak in één zin',
    expect: `Maakt zowel de taak als de afspraak (op ${v.day} om ${v.start}); één bevestiging, beide uitgevoerd.`,
    turns: [{ text: v.say }, { text: 'Ja, allebei.' }],
    checks: [
      { after: 1, name: 'taak bestaat', test: async (api) => (await taskNamed(api, v.task)) !== null },
      {
        after: 1,
        name: `afspraak om ${v.start}`,
        test: async (api) => (await eventsOn(api, v.day, v.event)).some((event) => clockOf(event.startsAt) === v.start)
      }
    ],
    toolBudget: 5
  }
}

function deadline(variant: string, v: { task: string; due: string; minutes: number; ask: string; keyword: RegExp }): Scenario {
  return {
    id: `C6${variant}`,
    family: 'deadline-risico',
    category: 'challenge',
    title: `Deadline ${v.task.toLowerCase()}`,
    expect: `Beantwoordt de vraag en wijst uit zichzelf op "${v.task}": deadline ${dayName(v.due)} ${v.due}, ${v.minutes} min werk, nog niet ingepland; biedt aan het in te plannen.`,
    setup: async (api) => {
      await api.tasks.create({ title: v.task, areaId: 'personal', estimateMin: v.minutes, priority: 'high', dueDate: v.due })
    },
    turns: [{ text: v.ask }],
    truth: snapshotTruth(),
    checks: [{ after: 0, name: 'noemt de deadline', test: replyHas(v.keyword) }],
    toolBudget: 2
  }
}

function cancelled(variant: string, v: { say: string; no: string; keyword: RegExp; day: string }): Scenario {
  return {
    id: `C7${variant}`,
    family: 'annuleren',
    category: 'challenge',
    title: `"${v.no}"`,
    expect: 'Stelt het voor en vraagt bevestiging; na de afwijzing doet hij niets en laat het voorstel vallen.',
    turns: [{ text: v.say }, { text: v.no }],
    checks: [
      {
        after: 1,
        name: 'niets aangemaakt',
        test: async (api) =>
          (await taskNamed(api, v.keyword)) === null && (await eventsOn(api, v.day, v.keyword)).length === 0 && (await blocksOn(api, v.day, v.keyword)).length === 0
      }
    ],
    toolBudget: 3
  }
}

function kind(variant: string, v: { say: string; day: string; keyword: RegExp; appointment: boolean }): Scenario {
  return {
    id: `C8${variant}`,
    family: 'afspraak of taak',
    category: 'challenge',
    title: v.appointment ? 'Is een afspraak' : 'Is een taak',
    expect: v.appointment
      ? 'Een vast moment met iemand of ergens: maakt een AFSPRAAK (create_appointment), geen taak.'
      : 'Werk dat Hidde zelf doet: maakt een TAAK met een blok op die tijd, geen afspraak.',
    turns: [{ text: v.say }, { text: 'Ja.' }],
    checks: [
      {
        after: 1,
        name: v.appointment ? 'afspraak, geen taak' : 'taakblok, geen afspraak',
        test: async (api) => {
          const events = (await eventsOn(api, v.day, v.keyword)).length
          const blocks = (await blocksOn(api, v.day, v.keyword)).length
          // An appointment with travel also brings a travel event ("naar de garage").
          return v.appointment ? events >= 1 && blocks === 0 : blocks === 1 && events === 0
        }
      }
    ],
    toolBudget: 4
  }
}

const D1 = inDays(1)
const D2 = inDays(2)
const D3 = inDays(3)

const CHALLENGE: Scenario[] = [
  eveningAround('a', { day: D1, appointment: ['Etentje bij Juul', '19:00', '20:00'], tasks: [['Fiets repareren', 30], ['Mail opruimen', 20], ['Rekening betalen', 15]], from: '18:00', say: 'Zet morgenavond vanaf zes uur fiets repareren, mail opruimen en rekening betalen erin, maar niet tijdens het etentje.' }),
  eveningAround('b', { day: D2, appointment: ['Bioscoop', '20:00', '21:30'], tasks: [['Studieboek lezen', 60], ['Planten water geven', 15], ['Boodschappenlijst maken', 15]], from: '18:00', say: 'Overmorgenavond ga ik naar de bioscoop. Kun je daarvoor vanaf zes uur studieboek lezen, planten water geven en een boodschappenlijst maken inplannen?' }),
  eveningAround('c', { day: D1, appointment: ['Tandarts', '18:30', '19:00'], tasks: [['Presentatie oefenen', 45], ['Kleding strijken', 20]], from: '18:00', say: 'Morgen na zessen wil ik presentatie oefenen en kleding strijken. Om half zeven zit ik bij de tandarts.' }),
  eveningAround('d', { day: D2, appointment: ['Verjaardag Sanne', '19:30', '21:00'], tasks: [['Cadeau inpakken', 20], ['Kaart schrijven', 15]], from: '17:30', say: 'Overmorgen vanaf half zes, voor de verjaardag van Sanne: cadeau inpakken en een kaart schrijven.' }),
  eveningAround('e', { day: D1, appointment: ['Hardlooptraining', '18:00', '19:00'], tasks: [['Afwas doen', 20], ['Rapport nakijken', 40], ['Was ophangen', 15]], from: '18:00', say: 'Morgenavond na de hardlooptraining wil ik afwas doen, het rapport nakijken en de was ophangen.' }),

  clash('a', { day: D1, appointment: ['Overleg Margriet', '10:00', '11:00'], task: ['Kast fixen', 60], say: 'Zet morgen om tien uur een uur kast fixen erin.' }),
  clash('b', { day: D2, appointment: ['Huisarts', '14:00', '15:30'], task: ['Stofzuigen', 30], say: 'Overmorgen om half drie wil ik stofzuigen, half uurtje.' }),
  clash('c', { day: D1, appointment: ['Voetbal', '19:00', '20:00'], task: ['Mail beantwoorden', 30], say: 'Kun je morgen kwart over zeven mail beantwoorden inplannen?' }),
  clash('d', { day: D3, appointment: ['Werkoverleg', '09:00', '12:00'], task: ['Rapport schrijven', 90], say: `Zet ${dayName(D3)} om tien uur anderhalf uur rapport schrijven erin.` }),
  clash('e', { day: D2, appointment: ['Kapper', '16:00', '17:00'], task: ['Fiets poetsen', 45], say: 'Overmorgen half vijf fiets poetsen, drie kwartier.' }),

  relativeDate('a', { day: D2, event: ['Sollicitatiegesprek', '11:00', '12:00'], phrase: 'overmorgen', keyword: /sollicitatie/i }),
  relativeDate('b', { day: weekdayNextWeek(2), event: ['Borrel stage', '17:00', '19:00'], phrase: 'volgende week dinsdag', keyword: /borrel/i }),
  relativeDate('c', { day: nextWeekday(6), event: ['Bruiloft Tim', '14:00', '23:00'], phrase: 'aanstaande zaterdag', keyword: /bruiloft/i }),
  relativeDate('d', { day: inDays(10), event: ['Autokeuring', '08:30', '09:30'], phrase: 'over tien dagen', keyword: /auto|keuring|apk/i }),
  relativeDate('e', { day: inDays(Math.round((new Date(`${weekdayNextWeek(5)}T12:00:00`).getTime() - Date.now()) / 86_400_000) + 7), event: ['Concert', '20:00', '23:00'], phrase: 'vrijdag over twee weken', keyword: /concert/i }),

  memory('a', { day: D1, task: 'Stofzuigen', start: '20:00', minutes: 30, move: 'Doe die van net een half uur eerder.', to: '19:30', say: 'Zet morgen om acht uur \'s avonds een half uur stofzuigen erin.' }),
  memory('b', { day: D1, task: 'Mail beantwoorden', start: '21:00', minutes: 30, move: 'Zet dat ding toch om acht uur \'s avonds.', to: '20:00', say: 'Morgen om negen uur \'s avonds half uur mail beantwoorden.' }),
  memory('c', { day: D2, task: 'Boek lezen', start: '19:00', minutes: 60, move: 'Schuif hem een uur op.', to: '20:00', say: 'Overmorgen om zeven uur \'s avonds een uur boek lezen.' }),
  memory('d', { day: D1, task: 'Planten water geven', start: '18:00', minutes: 15, move: 'Doe die toch maar een kwartier later.', to: '18:15', say: 'Morgen om zes uur \'s avonds een kwartiertje planten water geven.' }),
  memory('e', { day: D2, task: 'Wasje draaien', start: '19:00', minutes: 30, move: 'Die laatste taak twee uur later graag.', to: '21:00', say: 'Overmorgen om zeven uur \'s avonds een half uur wasje draaien.' }),

  twoInOne('a', { say: 'Voeg een taak lamp vervangen toe, een kwartier, en ik heb morgen om vier uur een afspraak bij de bank in Zevenaar, half uur, vijf minuten rijden.', task: /lamp/i, day: D1, event: /bank/i, start: '16:00' }),
  twoInOne('b', { say: 'Maak een taak verzekering opzeggen aan, half uur, en zet morgen om zeven uur \'s avonds bellen met oma als afspraak, twintig minuten, gewoon thuis.', task: /verzekering/i, day: D1, event: /oma/i, start: '19:00' }),
  twoInOne('c', { say: 'Ik heb overmorgen om elf uur de fysio in Duiven, drie kwartier, tien minuten rijden. En zet ook een taak: oefeningen uitprinten, tien minuten.', task: /oefening/i, day: D2, event: /fysio/i, start: '11:00' }),
  twoInOne('d', { say: 'Overmorgen om twee uur koffie met Tessie bij de Bagels in Arnhem, een uur, twintig minuten rijden, en maak een taak cadeautje voor Tessie kopen, half uur.', task: /cadeau/i, day: D2, event: /tessie/i, start: '14:00' }),
  twoInOne('e', { say: 'Taak erbij: fietsband oppompen, vijf minuten. En morgen om half vijf moet ik naar de garage in Zevenaar, half uur, vijf minuten rijden.', task: /fietsband|oppomp/i, day: D1, event: /garage/i, start: '16:30' }),

  deadline('a', { task: 'Belastingaangifte', due: D1, minutes: 120, ask: 'Hoe ziet morgen eruit?', keyword: /belasting/i }),
  deadline('b', { task: 'Verslag inleveren', due: inDays(0), minutes: 60, ask: 'Wat staat er vandaag nog?', keyword: /verslag/i }),
  deadline('c', { task: 'Huur overmaken', due: D2, minutes: 15, ask: 'Wat moet ik overmorgen doen?', keyword: /huur/i }),
  deadline('d', { task: 'Presentatie maken', due: D1, minutes: 180, ask: 'Heb ik morgen nog ruimte om te sporten?', keyword: /presentatie/i }),
  deadline('e', { task: 'Formulier opsturen', due: D2, minutes: 30, ask: 'Moet ik de komende dagen ergens op letten?', keyword: /formulier/i }),

  cancelled('a', { say: 'Zet morgen om acht uur \'s avonds een uur gamen erin.', no: 'Nee, laat maar.', keyword: /gamen/i, day: D1 }),
  cancelled('b', { say: 'Maak een afspraak overmorgen om twee uur met de makelaar, een uur, online.', no: 'Wacht, toch niet.', keyword: /makelaar/i, day: D2 }),
  cancelled('c', { say: 'Voeg een taak toe: garage opruimen, twee uur, morgen om zeven uur \'s avonds.', no: 'Stop, doe maar niet.', keyword: /garage/i, day: D1 }),
  cancelled('d', { say: 'Plan morgen om zeven uur \'s ochtends yoga, half uur.', no: 'Hmm nee, geen zin in eigenlijk.', keyword: /yoga/i, day: D1 }),
  cancelled('e', { say: 'Zet overmorgen om drie uur een uur boodschappen doen erin.', no: 'Laat maar zitten.', keyword: /boodschappen doen/i, day: D2 }),

  kind('a', { say: 'Ik moet overmorgen om tien uur naar de garage voor de APK, een uur, tien minuten rijden.', day: D2, keyword: /garage|apk/i, appointment: true }),
  kind('b', { say: 'Ik wil overmorgen om tien uur een uur de schuur opruimen.', day: D2, keyword: /schuur/i, appointment: false }),
  kind('c', { say: 'Morgen om drie uur bel ik met de huisarts, tien minuten.', day: D1, keyword: /huisarts/i, appointment: true }),
  kind('d', { say: 'Morgen om drie uur wil ik een uur aan mijn verslag schrijven.', day: D1, keyword: /verslag/i, appointment: false }),
  kind('e', { say: 'Overmorgen om zes uur eet ik bij mijn ouders in Arnhem, twee uur, half uur rijden.', day: D2, keyword: /ouders|eten/i, appointment: true })
]

// ------------------------------------------------------- compound set
//
// SET=samengesteld: long sentences with several things in them, the way Hidde really talks
// (28 Sep 2026: "wie betaalt wat is al gebeurd, uitzoeken verjaardag ook, en zet financiën
// vanavond"), with self-corrections, filler words and a change of mind. Every scenario is
// checked on what ended up in the database, not only on what he said.

const isDone = (title: RegExp) => async (api: TimeTrackerAPI) => (await taskNamed(api, title))?.status === 'done'
const blockAt = (day: string, title: RegExp, start: string, end?: string) => async (api: TimeTrackerAPI) =>
  (await blocksOn(api, day, title)).some((block) => block.startMin === at(start) && (!end || block.endMin === at(end)))
const noBlock = (day: string, title: RegExp) => async (api: TimeTrackerAPI) => (await blocksOn(api, day, title)).length === 0
const makeTasks = (tasks: Array<[string, number, string?]>) => async (api: TimeTrackerAPI) => {
  for (const [title, minutes, areaId] of tasks) await api.tasks.create({ title, areaId: areaId ?? 'personal', estimateMin: minutes })
}

const TODAY = inDays(0)

const COMPOUND: Scenario[] = [
  {
    id: 'S1',
    family: 'afvinken + plannen',
    category: 'challenge',
    title: 'Twee dingen af, één inplannen',
    expect: 'Vinkt Fietsband plakken en Belasting nakijken af en zet Garage opruimen vanavond 19:00–20:00 in; één samenvatting, één bevestiging, alles uitgevoerd.',
    setup: makeTasks([['Fietsband plakken', 30], ['Belasting nakijken', 60], ['Garage opruimen', 60]]),
    turns: [{ text: 'Ja prima. Fietsband plakken is al gebeurd, belasting nakijken ook, en zet garage opruimen vanavond om zeven uur, een uurtje.' }, { text: 'Ja.' }],
    checks: [
      { after: 1, name: 'fietsband af', test: isDone(/fietsband/i) },
      { after: 1, name: 'belasting af', test: isDone(/belasting nakijken/i) },
      { after: 1, name: 'garage 19:00–20:00', test: blockAt(TODAY, /garage/i, '19:00', '20:00') }
    ],
    toolBudget: 6
  },
  {
    id: 'S2',
    family: 'zelfcorrectie',
    category: 'challenge',
    title: 'Nee wacht, half vier',
    expect: 'Neemt de verbetering: Scriptie lezen morgen 15:30–16:30, niet om 15:00.',
    setup: makeTasks([['Scriptie lezen', 60, 'school']]),
    turns: [{ text: 'Zet morgen om drie uur scriptie lezen erin, nee wacht, om half vier, een uur.' }, { text: 'Ja, goed.' }],
    checks: [
      { after: 1, name: 'om 15:30', test: blockAt(D1, /scriptie/i, '15:30', '16:30') },
      { after: 1, name: 'niet om 15:00', test: async (api) => !(await blockAt(D1, /scriptie/i, '15:00')(api)) }
    ],
    toolBudget: 4
  },
  {
    id: 'S3',
    family: 'rommelige zin',
    category: 'challenge',
    title: 'Eh, na mijn stage, twee dingen',
    expect: 'Haalt uit de rommelige zin: Kast fixen (60) en Boodschappen doen (30) morgen na de stage (na 17:00), elk met hun eigen duur, één voorstel.',
    setup: makeTasks([['Kast fixen', 60], ['Boodschappen doen', 30]]),
    turns: [{ text: 'Eh ja dus ik dacht, kun je misschien, als dat kan, morgen na mijn stage eh de kast fixen en dan ook de boodschappen doen, ja?' }, { text: 'Ja, doe maar.' }],
    checks: [
      {
        after: 1,
        name: 'beide na 17:00 morgen',
        test: async (api) => {
          const kast = (await blocksOn(api, D1, /kast/i)).filter((block) => block.startMin >= 17 * 60)
          const boodschap = (await blocksOn(api, D1, /boodschappen/i)).filter((block) => block.startMin >= 17 * 60)
          return kast.length === 1 && boodschap.length === 1 && kast[0]!.endMin - kast[0]!.startMin === 60 && boodschap[0]!.endMin - boodschap[0]!.startMin === 30
        }
      }
    ],
    toolBudget: 5
  },
  {
    id: 'S4',
    family: 'overlap mag',
    category: 'challenge',
    title: 'Maakt niet uit dat het overlapt',
    expect: 'Zet Rapport printen morgen 12:00–14:00, ook al staat daar al een andere taak (taken mogen overlappen); vraagt niet opnieuw.',
    setup: async (api) => {
      await makeTasks([['Rapport printen', 120], ['Mail wegwerken', 60]])(api)
      const mail = await taskNamed(api, /mail wegwerken/i)
      const proposed = (await runTool(api, 'schedule_task', { taskId: mail!.id, date: D1, start: '12:30', end: '13:30' })) as { pendingId?: string }
      if (proposed.pendingId) await runTool(api, 'confirm', { pendingIds: [proposed.pendingId] })
    },
    turns: [{ text: 'Zet rapport printen alsjeblieft morgen tussen twaalf en twee. Maakt niet uit dat het overlapt.' }, { text: 'Ja.' }],
    checks: [{ after: 1, name: 'rapport 12:00–14:00', test: blockAt(D1, /rapport printen/i, '12:00', '14:00') }],
    toolBudget: 4
  },
  {
    id: 'S5',
    family: 'afspraak + af + taak',
    category: 'challenge',
    title: 'Drie soorten in één zin',
    expect: `Maakt afspraak Tandarts vrijdag ${FRIDAY} 10:00–10:30 (Zevenaar, 10 min rijden), vinkt Belasting nakijken af, en zet Verslag schrijven morgen 19:00–20:00; één bevestiging.`,
    setup: makeTasks([['Belasting nakijken', 60], ['Verslag schrijven', 60, 'school']]),
    turns: [{ text: 'Ik heb vrijdag om tien uur de tandarts in Zevenaar, half uur, tien minuten rijden. Belasting nakijken is af. En zet morgenavond om zeven een uur verslag schrijven.' }, { text: 'Ja, allemaal.' }],
    checks: [
      { after: 1, name: 'tandarts vr 10:00', test: async (api) => (await eventsOn(api, FRIDAY, /tandarts/i)).some((event) => clockOf(event.startsAt) === '10:00') },
      { after: 1, name: 'belasting af', test: isDone(/belasting nakijken/i) },
      { after: 1, name: 'verslag morgen 19:00', test: blockAt(D1, /verslag schrijven/i, '19:00', '20:00') }
    ],
    toolBudget: 6
  },
  {
    id: 'S6',
    family: 'vraag + actie',
    category: 'challenge',
    title: 'Wat heb ik, en zet erbij',
    expect: 'Noemt kort wat er morgen staat en stelt voor Planten verpotten morgen na 18:00 (30 min) in te plannen; na ja staat het erin.',
    setup: makeTasks([['Planten verpotten', 30]]),
    turns: [{ text: 'Wat heb ik morgen allemaal, en zet daar na zessen planten verpotten bij.' }, { text: 'Ja.' }],
    truth: snapshotTruth(),
    checks: [
      {
        after: 1,
        name: 'verpotten na 18:00',
        test: async (api) => (await blocksOn(api, D1, /verpotten/i)).some((block) => block.startMin >= 18 * 60 && block.endMin - block.startMin === 30)
      }
    ],
    toolBudget: 4
  },
  {
    id: 'S7',
    family: 'ongedaan maken',
    category: 'challenge',
    title: 'Oh nee, haal die toch weg',
    expect: 'Zet Hardlopen morgen 07:00–07:30 na ja, en haalt het na "haal die toch weg" weer uit de planning (na bevestiging). De taak zelf blijft bestaan, niet afgevinkt.',
    setup: makeTasks([['Hardlopen', 30]]),
    turns: [{ text: 'Zet morgen om zeven uur s ochtends hardlopen erin, half uur.' }, { text: 'Ja.' }, { text: 'Oh nee, haal die toch maar weg.' }, { text: 'Ja.' }],
    checks: [
      { after: 1, name: 'eerst ingepland', test: blockAt(D1, /hardlopen/i, '07:00') },
      { after: 3, name: 'daarna weg', test: noBlock(D1, /hardlopen/i) },
      { after: 3, name: 'niet afgevinkt', test: async (api) => (await taskNamed(api, /hardlopen/i))?.status !== 'done' }
    ],
    toolBudget: 7
  },
  {
    id: 'S8',
    family: 'van gedachten veranderen',
    category: 'challenge',
    title: 'Nee laat maar, ... nee ik wil het wel',
    expect: 'Na "nee laat maar" laat hij het vallen; na "nee nee, ik wil het wel, tussen twaalf en twee" zet hij Financiën ordenen morgen 12:00–14:00 (na ja).',
    setup: makeTasks([['Financiën ordenen', 120]]),
    turns: [
      { text: 'Zet financiën ordenen morgen van twaalf tot twee.' },
      { text: 'Nee, laat maar.' },
      { text: 'Nee nee nee, ik wil het wel doen. Tussen twaalf en twee.' },
      { text: 'Ja.' }
    ],
    checks: [{ after: 3, name: 'financiën 12:00–14:00', test: blockAt(D1, /financiën ordenen/i, '12:00', '14:00') }],
    toolBudget: 7
  },
  {
    id: 'S9',
    family: 'afvinken wat gepland staat',
    category: 'challenge',
    title: 'Is al af, haal het uit de planning',
    expect: 'Vinkt Presentatie oefenen af; de blokken van morgen en overmorgen verdwijnen daarmee vanzelf. Zegt niet dat hij iets doet wat hij niet doet.',
    setup: async (api) => {
      await makeTasks([['Presentatie oefenen', 60, 'school']])(api)
      const task = await taskNamed(api, /presentatie oefenen/i)
      for (const day of [D1, D2]) {
        const proposed = (await runTool(api, 'schedule_task', { taskId: task!.id, date: day, start: '19:00', end: '20:00' })) as { pendingId?: string }
        if (proposed.pendingId) await runTool(api, 'confirm', { pendingIds: [proposed.pendingId] })
      }
    },
    turns: [{ text: 'Presentatie oefenen heb ik al gedaan, dus die kan uit de planning.' }, { text: 'Ja.' }],
    checks: [
      { after: 1, name: 'afgevinkt', test: isDone(/presentatie oefenen/i) },
      { after: 1, name: 'morgen weg', test: noBlock(D1, /presentatie oefenen/i) },
      { after: 1, name: 'overmorgen weg', test: noBlock(D2, /presentatie oefenen/i) }
    ],
    toolBudget: 4
  },
  {
    id: 'S10',
    family: 'meerdere dagen',
    category: 'challenge',
    title: 'Morgen en overmorgen elk een uur',
    expect: 'Zet Scriptie lezen morgen én overmorgen 20:00–21:00 in; één voorstel, één bevestiging.',
    setup: makeTasks([['Scriptie lezen', 120, 'school']]),
    turns: [{ text: 'Zet scriptie lezen morgen en overmorgen allebei om acht uur s avonds, steeds een uur.' }, { text: 'Ja prima.' }],
    checks: [
      { after: 1, name: 'morgen 20:00', test: blockAt(D1, /scriptie lezen/i, '20:00', '21:00') },
      { after: 1, name: 'overmorgen 20:00', test: blockAt(D2, /scriptie lezen/i, '20:00', '21:00') }
    ],
    toolBudget: 5
  },
  {
    id: 'S11',
    family: 'verhaspeld',
    category: 'challenge',
    title: '"Joe, staan u niet in planeet"',
    expect: 'Begrijpt de verhaspelde zin (echte transcriptie): Fiets repareren en Mail wegwerken staan niet ingepland; zet ze morgenavond na 18:00 in, elk met eigen duur; één voorstel.',
    setup: makeTasks([['Fiets repareren', 30], ['Mail wegwerken', 30]]),
    turns: [{ text: 'Joe, staan u fiets repareren en mail weg werken niet in planeet? Als die niet zijn ingepland, zet ze dan morgenavond na zessen in de agend.' }, { text: 'Ja.' }],
    checks: [
      { after: 1, name: 'fiets morgen na 18:00', test: async (api) => (await blocksOn(api, D1, /fiets repareren/i)).some((block) => block.startMin >= 18 * 60) },
      { after: 1, name: 'mail morgen na 18:00', test: async (api) => (await blocksOn(api, D1, /mail wegwerken/i)).some((block) => block.startMin >= 18 * 60) }
    ],
    toolBudget: 5
  },
  {
    id: 'S12',
    family: 'verhaspeld',
    category: 'challenge',
    title: '"kasfixer" is Kast fixen',
    expect: 'Herkent "kasfixer" als de bestaande taak Kast fixen en zet die morgen 20:00–21:00; maakt geen nieuwe taak "kasfixer".',
    setup: makeTasks([['Kast fixen', 60]]),
    turns: [{ text: 'zet morgavond om acht uur een uur kasfixer in.' }, { text: 'Ja, toe maar!' }],
    checks: [
      { after: 1, name: 'kast fixen 20:00', test: blockAt(D1, /kast fixen/i, '20:00', '21:00') },
      { after: 1, name: 'geen taak kasfixer', test: async (api) => (await taskNamed(api, /kasfixer/i)) === null }
    ],
    toolBudget: 4
  },
  {
    id: 'S13',
    family: 'zelfcorrectie',
    category: 'challenge',
    title: 'Die ook, nee wacht, die nog niet',
    expect: 'Vinkt alleen Rekening betalen af; Verjaardag plannen blijft open (hij nam het terug).',
    setup: makeTasks([['Rekening betalen', 15], ['Verjaardag plannen', 30]]),
    turns: [{ text: 'Ja dus eh, de rekening betalen, die is al af, en eh, verjaardag plannen ook, en eh nee wacht, die verjaardag nog niet.' }, { text: 'Ja klopt.' }],
    checks: [
      { after: 1, name: 'rekening af', test: isDone(/rekening betalen/i) },
      { after: 1, name: 'verjaardag nog open', test: async (api) => (await taskNamed(api, /verjaardag plannen/i))?.status !== 'done' }
    ],
    toolBudget: 4
  },
  {
    id: 'S14',
    family: 'lange zin',
    category: 'challenge',
    title: 'Vraag, twee acties en een regel',
    expect: 'Beantwoordt de vraag kort, vinkt Belasting nakijken af, zet Garage opruimen morgen 19:00–20:00, en maakt een vaste regel dat er op zondag niets gepland wordt; alles in één voorstel met één bevestiging.',
    setup: makeTasks([['Belasting nakijken', 60], ['Garage opruimen', 60]]),
    turns: [
      { text: 'Oké luister, hoe laat ben ik morgen klaar met stage? En belasting nakijken is gedaan, garage opruimen wil ik morgenavond om zeven doen, een uur, en voortaan wil ik op zondag helemaal niks ingepland hebben.' },
      { text: 'Ja, alles.' }
    ],
    truth: snapshotTruth(),
    checks: [
      { after: 1, name: 'belasting af', test: isDone(/belasting nakijken/i) },
      { after: 1, name: 'garage 19:00', test: blockAt(D1, /garage/i, '19:00', '20:00') },
      { after: 1, name: 'regel over zondag', test: async (api) => (await api.assistant.rules()).some((rule) => rule.active && /zondag/i.test(rule.description)) }
    ],
    toolBudget: 7
  },
  {
    id: 'S15',
    family: 'reistijd vragen',
    category: 'challenge',
    title: 'Kapper zonder plek of reistijd',
    expect: 'Vraagt eerst waar het is en hoe lang hij reist (en maakt nog niets); na het antwoord stelt hij de afspraak Kapper donderdag 15:00 voor met 10 minuten reistijd, en na ja staat die erin.',
    turns: [{ text: `Ik heb donderdag om drie uur een afspraak bij de kapper, half uur.` }, { text: 'In Zevenaar, tien minuten fietsen.' }, { text: 'Ja.' }],
    checks: [
      { after: 0, name: 'vraagt eerst, maakt niets', test: async (api, turns) => turns[0]!.reply.includes('?') && (await eventsOn(api, THURSDAY, /kapper/i)).length === 0 },
      { after: 2, name: 'kapper do 15:00', test: async (api) => (await eventsOn(api, THURSDAY, /kapper/i)).some((event) => clockOf(event.startsAt) === '15:00') }
    ],
    toolBudget: 5
  },
  {
    id: 'S16',
    family: 'afspreken met iemand',
    category: 'challenge',
    title: 'Wanneer kan ik met Juul afspreken',
    expect: 'Zoekt met find_meeting_times vrije avondmomenten deze week en noemt kort twee of drie opties; maakt nog niets aan.',
    turns: [{ text: 'Wanneer kan ik deze week s avonds een uurtje met Juul afspreken?' }],
    checks: [{ after: 0, name: 'zoekt met de tool', test: async (_api, turns) => turns[0]!.tools.some((tool) => tool.name === 'find_meeting_times') }],
    toolBudget: 2
  },
  {
    id: 'S17',
    family: 'afspreken met iemand',
    category: 'challenge',
    title: 'Koffie met Tessie: zoeken, kiezen, vastleggen',
    expect: 'Zoekt momenten van 90 minuten na de stage met 20 minuten reistijd; na "doe de eerste maar" stelt hij die afspraak voor met 20 minuten reistijd in Arnhem, en na ja staat die erin.',
    turns: [
      { text: 'Zoek een moment voor koffie met Tessie in Arnhem, anderhalf uur, twintig minuten rijden, ergens deze week na mijn stage.' },
      { text: 'Doe de eerste maar.' },
      { text: 'Ja.' }
    ],
    checks: [
      { after: 0, name: 'zoekt met de tool', test: async (_api, turns) => turns[0]!.tools.some((tool) => tool.name === 'find_meeting_times') },
      {
        after: 2,
        name: 'afspraak met Tessie staat erin',
        test: async (api) => {
          for (let offset = 0; offset <= 7; offset += 1) if ((await eventsOn(api, inDays(offset), /tessie|koffie/i)).length > 0) return true
          return false
        }
      }
    ],
    toolBudget: 6
  },
  {
    id: 'S18',
    family: 'afspreken met iemand',
    category: 'challenge',
    title: 'Een berichtje voor Sanne',
    expect: 'Zoekt momenten voor een etentje van twee uur deze week en geeft een berichtje met de opties dat Hidde naar Sanne kan sturen.',
    turns: [{ text: 'Kun je een berichtje maken dat ik naar Sanne kan sturen voor een etentje van twee uur deze week?' }],
    checks: [{ after: 0, name: 'geeft opties in een berichtje', test: async (_api, turns) => turns[0]!.tools.some((tool) => tool.name === 'find_meeting_times') && /\d{1,2}[:.]\d{2}|om \d/.test(turns[0]!.reply) }],
    toolBudget: 2
  }
]

// ------------------------------------------------------- neutral prompt
//
// PROMPT=neutraal (the challenge set's default): without the lines written after Gemini
// Live's mistakes. Everything else (facts looked up by code, the proposal flow) stays: that
// helps every model the same.

const GEMINI_PATCHES = [
  '- Zeg nooit "ik ga het regelen" of "ik help je er zo bij" zonder in dezelfde beurt de tool\n  aan te roepen. Kun je nog niets doen, vraag dan meteen wat je nodig hebt.\n',
  '- Noemt Hidde meerdere dingen in één keer, pak ze allemaal op; laat er geen vallen.\n',
  'Staat het antwoord hieronder al, geef het dan meteen, zonder "even kijken". Alleen als je\necht een tool aanroept zeg je hooguit "even kijken", en je geeft het antwoord zodra het\nresultaat binnen is (dat duurt een fractie van een seconde).\nZeg nooit dat je later terugkomt.\n'
]

function neutral(fixed: string): string {
  let out = fixed
  for (const patch of GEMINI_PATCHES) {
    if (!out.includes(patch)) throw new Error(`Neutrale prompt: patch niet gevonden, is de tekst veranderd? "${patch.slice(0, 50)}"`)
    out = out.replace(patch, '')
  }
  return out
}

// ------------------------------------------------------------------ voice

const VOICE_CACHE = join('node_modules', '.cache', 'uurwerk', 'bench-voice')
mkdirSync(VOICE_CACHE, { recursive: true })

/** Dutch speech, 24 kHz 16-bit mono; made once per line and kept, so reruns cost nothing. */
async function clip(text: string): Promise<Buffer> {
  const file = join(VOICE_CACHE, `${createHash('sha1').update(text).digest('hex').slice(0, 12)}.pcm`)
  if (existsSync(file)) return readFileSync(file)
  const wav = await speakGemini(text, GEMINI_KEY, 'Kore', 'gemini-3.8-flash-lite-tts')
  const pcm = Buffer.from(wav.buffer, wav.byteOffset + 44, wav.byteLength - 44)
  writeFileSync(file, pcm)
  return pcm
}

// ---------------------------------------------------------------- drivers

type Provider = 'openai' | 'openai-full' | 'gemini' | Brainy
/** Text brains for a cascade, measured on their own. */
type Brainy = 'flash' | 'terra' | 'gpt-mini' | 'sonnet' | 'haiku'
const BRAINS: Brainy[] = ['flash', 'terra', 'gpt-mini', 'sonnet', 'haiku']
const isBrain = (provider: Provider): provider is Brainy => (BRAINS as string[]).includes(provider)

const MODEL: Record<Provider, string> = {
  openai: 'gpt-realtime-2.1-mini',
  'openai-full': 'gpt-realtime-2.1',
  gemini: 'gemini-3.8-live-extended-thinking',
  // The brain of a cascade, measured on its own: typed turns, no speech either way.
  flash: process.env.FLASH_MODEL?.trim() || 'gemini-3.8-flash',
  terra: 'gpt-5.6-terra',
  'gpt-mini': 'gpt-5.4-mini',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5'
}
const costOf = (provider: Provider, usage: JarvisLiveUsage): number => {
  // A brain prices its own turns (cache writes and all): that lands in extraUsd.
  return isBrain(provider) ? 0 : usageUsd(usage, MODEL[provider])
}

interface ToolUse {
  name: string
  args: Record<string, unknown>
  error: string | null
  /** What the tool gave back, shortened: the judge needs it to tell a fact from an invention. */
  result?: string
}

interface Turn {
  said: string
  heard: string
  reply: string
  tools: ToolUse[]
  firstAudioMs: number | null
  totalMs: number
  audioSec: number
  usage: JarvisLiveUsage
  /** Costs outside the token usage (the cascade's cache). */
  extraUsd: number
  problems: string[]
}

interface Driver {
  turn(input: { text: string; spoken?: boolean }): Promise<Turn>
  close(): void
}

const blankUsage = (provider: Provider): JarvisLiveUsage => ({
  provider: provider === 'gemini' || provider === 'flash' ? 'gemini' : 'openai',
  textIn: 0,
  audioIn: 0,
  textOut: 0,
  audioOut: 0,
  thoughts: 0,
  textInCached: 0,
  audioInCached: 0
})
const blankTurn = (provider: Provider, said: string): Turn => ({
  said,
  heard: '',
  reply: '',
  tools: [],
  firstAudioMs: null,
  totalMs: 0,
  audioSec: 0,
  usage: blankUsage(provider),
  extraUsd: 0,
  problems: []
})
const addUsage = (into: JarvisLiveUsage, more: JarvisLiveUsage): void => {
  for (const kind of ['textIn', 'audioIn', 'textOut', 'audioOut', 'thoughts', 'textInCached', 'audioInCached'] as const) {
    into[kind] = (into[kind] ?? 0) + (more[kind] ?? 0)
  }
}

async function useTool(api: TimeTrackerAPI, turn: Turn, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const result = await runTool(api, name, args)
    const error = result && typeof result === 'object' && 'error' in result ? String((result as { error: unknown }).error) : null
    turn.tools.push({ name, args, error, result: JSON.stringify(result).slice(0, 400) })
    return { result }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    turn.tools.push({ name, args, error: message })
    return { error: message }
  }
}

const TURN_TIMEOUT = 45_000

async function geminiDriver(api: TimeTrackerAPI, opening: string | null): Promise<Driver> {
  const live = await liveSession({ api, key: GEMINI_KEY, system: SYSTEM, voice: 'Orus', opening, usagePath: join(work, 'spend-gemini.json') })
  const ai = new GoogleGenAI({ apiKey: live.token, httpOptions: { apiVersion: live.apiVersion } })
  let handler: ((message: LiveServerMessage) => void) | null = null
  const errors: string[] = []
  const session = await ai.live.connect({
    model: live.model,
    config: live.config,
    callbacks: {
      onmessage: (message) => handler?.(message),
      onerror: (event) => errors.push(`fout: ${event.message}`),
      onclose: (event) => {
        if (event.code !== 1000) errors.push(`verbinding dicht ${event.code}: ${event.reason}`)
      }
    }
  })

  return {
    turn: (input) =>
      new Promise<Turn>((resolve) => {
        const turn = blankTurn('gemini', input.text)
        const started = Date.now()
        let spokenEnd = 0
        let pending = 0
        let heardAudio = false
        let spokeAfterTools = false
        let turnUsage: JarvisLiveUsage | null = null
        const timer = setTimeout(() => {
          turn.problems.push('time-out')
          finish()
        }, TURN_TIMEOUT)
        const finish = (): void => {
          clearTimeout(timer)
          handler = null
          if (turnUsage) addUsage(turn.usage, turnUsage)
          turn.totalMs = Date.now() - (spokenEnd || started)
          turn.problems.push(...errors.splice(0))
          resolve(turn)
        }
        handler = (message) => {
          const content = message.serverContent
          if (content?.inputTranscription?.text) turn.heard += content.inputTranscription.text
          for (const part of content?.modelTurn?.parts ?? []) {
            if (!part.inlineData?.data) continue
            heardAudio = true
            turn.audioSec += Buffer.from(part.inlineData.data, 'base64').length / 48_000
            if (turn.firstAudioMs === null && spokenEnd) turn.firstAudioMs = Date.now() - spokenEnd
            if (pending === 0 && turn.tools.length > 0) spokeAfterTools = true
          }
          if (content?.outputTranscription?.text) turn.reply += content.outputTranscription.text
          if (message.usageMetadata) {
            const meta = message.usageMetadata
            const part = { ...blankUsage('gemini'), thoughts: meta.thoughtsTokenCount ?? 0 }
            for (const entry of meta.promptTokensDetails ?? []) {
              if (String(entry.modality) === 'TEXT') part.textIn += entry.tokenCount ?? 0
              else part.audioIn += entry.tokenCount ?? 0
            }
            for (const entry of meta.responseTokensDetails ?? []) {
              if (String(entry.modality) === 'TEXT') part.textOut += entry.tokenCount ?? 0
              else part.audioOut += entry.tokenCount ?? 0
            }
            // As the app counts: the latest report of a generation, added when it completes.
            turnUsage = part
          }
          if (message.toolCall?.functionCalls?.length) {
            const calls = message.toolCall.functionCalls
            pending += calls.length
            void Promise.all(
              calls.map(async (call) => ({
                id: call.id,
                name: call.name,
                response: await useTool(api, turn, call.name ?? '', (call.args ?? {}) as Record<string, unknown>)
              }))
            ).then((responses) => {
              pending -= responses.length
              session.sendToolResponse({ functionResponses: responses })
            })
          }
          if (content?.turnComplete) {
            if (turnUsage) addUsage(turn.usage, turnUsage)
            turnUsage = null
            const idle = String(content.interactionStatus ?? 'IDLE') !== 'IN_PROGRESS'
            if (heardAudio && pending === 0 && idle && (turn.tools.length === 0 || spokeAfterTools)) finish()
          }
        }
        void (async () => {
          if (!input.spoken) {
            session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: input.text }] }], turnComplete: true })
            spokenEnd = Date.now()
            return
          }
          const pcm = await clip(input.text)
          const send = (bytes: Buffer): void =>
            session.sendRealtimeInput({ audio: { data: bytes.toString('base64'), mimeType: 'audio/pcm;rate=24000' } })
          for (let at = 0; at < pcm.length; at += 1920) {
            send(pcm.subarray(at, at + 1920))
            await sleep(10)
          }
          spokenEnd = Date.now()
          // The app's gate: 1.5 s of quiet at real time, then "microphone paused".
          for (let quiet = 0; quiet < 1500; quiet += 40) {
            send(Buffer.alloc(1920))
            await sleep(40)
          }
          session.sendRealtimeInput({ audioStreamEnd: true })
        })()
      }),
    close: () => session.close()
  }
}

/**
 * The cascade's brain on its own: Gemini Flash over its native streaming API with the fixed
 * instruction cached (brain.ts), typed turns, no speech either way. "firstAudioMs" is when
 * the first words of text arrive; speech would add the text-to-speech start on top.
 */
/**
 * INTAKE=kort: the "proposal first" reading of the brief's intake questions, still to be
 * decided for the app. Without it, the strictest models ask all intake questions before
 * proposing anything, and a scripted conversation cannot answer them.
 */
const INTAKE_SHORT = `

--- INTAKE ---
De afsprakenvragen en takenvragen uit de brief stel je niet als verhoor vooraf. Wat je redelijk
kunt invullen (gebied uit de context, duur uit wat hij zei, geen deadline, met de auto) vul je
zelf in en noem je kort in het voorstel; Hidde verbetert je als het anders moet. Vraag alleen
wat echt ontbreekt om het voorstel te maken (welke dag, hoe laat), één vraag tegelijk.`

async function brainDriver(api: TimeTrackerAPI, opening: string | null, provider: Brainy): Promise<Driver> {
  const base = instructionParts({ api, system: SYSTEM, opening })
  const prompt = process.env.PROMPT ?? (process.env.SET === 'challenge' ? 'neutraal' : 'jarvis')
  const intake = process.env.INTAKE ?? (process.env.SET === 'challenge' ? 'kort' : '')
  const fixed = prompt === 'neutraal' ? neutral(base.fixed) : base.fixed
  const parts = { ...base, fixed: intake === 'kort' ? fixed + INTAKE_SHORT : fixed }
  const effort = (process.env.BRAIN_EFFORT?.trim() || 'low') as 'low' | 'medium' | 'high'
  const brain: ThinkingBrain =
    provider === 'flash'
      ? new Brain({ key: GEMINI_KEY, model: MODEL.flash, thinking: effort, fixed: parts.fixed })
      : provider === 'sonnet' || provider === 'haiku'
        ? new ClaudeBrain({
            key: key('ANTHROPIC_API_KEY'),
            model: MODEL[provider],
            fixed: parts.fixed,
            // Sonnet 5 thinks unless told not to; Haiku 4.5 does not.
            thinking: provider === 'sonnet' ? ((process.env.CLAUDE_THINKING?.trim() || 'low') as 'off' | 'low' | 'medium') : 'off'
          })
        : new OpenAIBrain({
            key: OPENAI_KEY,
            model: MODEL[provider],
            fixed: parts.fixed,
            effort: (process.env.OPENAI_EFFORT?.trim() || effort) as 'none' | 'minimal' | 'low' | 'medium' | 'high',
            verbosity: process.env.OPENAI_VERBOSITY?.trim() as 'low' | 'medium' | 'high' | undefined
          })
  if (brain instanceof Brain) await brain.warm()
  return {
    turn: async (input) => {
      const turn = blankTurn(provider, input.text)
      const started = Date.now()
      try {
        const reply = await Promise.race([
          brain.turn(input.text, await parts.state(), async (name, args) => {
            const output = await useTool(api, turn, name, args)
            return 'result' in output ? output.result : output
          }),
          sleep(TURN_TIMEOUT).then(() => null)
        ])
        if (reply) {
          turn.reply = reply.text
          turn.firstAudioMs = reply.firstTextMs
          addUsage(turn.usage, reply.usage)
          turn.extraUsd += reply.usd
        } else turn.problems.push('time-out')
      } catch (error) {
        turn.problems.push(`fout: ${error instanceof Error ? error.message : String(error)}`)
      }
      turn.totalMs = Date.now() - started
      return turn
    },
    close: () => void brain.close()
  }
}

interface OpenAIEvent {
  type: string
  delta?: string
  transcript?: string
  error?: { message?: string; code?: string }
  response?: {
    status?: string
    status_details?: { error?: { code?: string; message?: string } }
    output?: Array<{ type: string; call_id?: string; name?: string; arguments?: string }>
    usage?: {
      input_token_details?: { text_tokens?: number; audio_tokens?: number; cached_tokens_details?: { text_tokens?: number; audio_tokens?: number } }
      output_token_details?: { text_tokens?: number; audio_tokens?: number }
    }
  }
}

async function openaiDriver(api: TimeTrackerAPI, opening: string | null, provider: 'openai' | 'openai-full'): Promise<Driver> {
  process.env.JARVIS_REALTIME_MODEL = MODEL[provider]
  const live = await openaiSession({ api, key: OPENAI_KEY, system: SYSTEM, voice: '', opening, usagePath: join(work, 'spend-openai.json') })
  const socket = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(live.model)}`, [
    'realtime',
    `openai-insecure-api-key.${live.token}`
  ])
  const errors: string[] = []
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = () => reject(new Error('geen verbinding met OpenAI'))
  })
  socket.onclose = (event) => {
    if (event.code !== 1000) errors.push(`verbinding dicht ${event.code}: ${event.reason}`)
  }
  let handler: ((event: OpenAIEvent) => void) | null = null
  socket.onmessage = (message) => handler?.(JSON.parse(String(message.data)) as OpenAIEvent)
  const send = (event: Record<string, unknown>): void => socket.send(JSON.stringify(event))

  return {
    turn: (input) =>
      new Promise<Turn>((resolve) => {
        const turn = blankTurn(provider, input.text)
        const started = Date.now()
        let spokenEnd = 0
        let retries = 0
        const timer = setTimeout(() => {
          turn.problems.push('time-out')
          finish()
        }, TURN_TIMEOUT)
        const finish = (): void => {
          clearTimeout(timer)
          handler = null
          turn.totalMs = Date.now() - (spokenEnd || started)
          turn.problems.push(...errors.splice(0))
          resolve(turn)
        }
        handler = (event) => {
          switch (event.type) {
            case 'conversation.item.input_audio_transcription.completed':
              turn.heard += event.transcript ?? ''
              break
            case 'response.output_audio.delta':
              turn.audioSec += Buffer.from(event.delta ?? '', 'base64').length / 48_000
              if (turn.firstAudioMs === null && spokenEnd) turn.firstAudioMs = Date.now() - spokenEnd
              break
            case 'response.output_audio_transcript.delta':
              turn.reply += event.delta ?? ''
              break
            case 'error':
              if (event.error?.code !== 'response_cancel_not_active') errors.push(`fout: ${event.error?.message ?? '?'}`)
              break
            case 'response.done': {
              const response = event.response
              const usage = response?.usage
              if (usage) {
                addUsage(turn.usage, {
                  ...blankUsage(provider),
                  textIn: usage.input_token_details?.text_tokens ?? 0,
                  audioIn: usage.input_token_details?.audio_tokens ?? 0,
                  textInCached: usage.input_token_details?.cached_tokens_details?.text_tokens ?? 0,
                  audioInCached: usage.input_token_details?.cached_tokens_details?.audio_tokens ?? 0,
                  textOut: usage.output_token_details?.text_tokens ?? 0,
                  audioOut: usage.output_token_details?.audio_tokens ?? 0
                })
              }
              const limited = response?.status_details?.error
              if (limited?.code === 'rate_limit_exceeded' && retries < 5) {
                retries += 1
                const seconds = Number(/try again in ([\d.]+)\s*s/i.exec(limited.message ?? '')?.[1] ?? 5)
                turn.problems.push(`(limiet, ${seconds.toFixed(1)} s gewacht)`)
                setTimeout(() => send({ type: 'response.create' }), seconds * 1000 + 500)
                return
              }
              if (response?.status === 'failed') {
                turn.problems.push(`antwoord mislukt: ${limited?.message ?? '?'}`)
                finish()
                return
              }
              const calls = (response?.output ?? []).filter((item) => item.type === 'function_call')
              if (calls.length === 0) {
                finish()
                return
              }
              void Promise.all(
                calls.map(async (call) => {
                  let args: Record<string, unknown> = {}
                  try {
                    args = JSON.parse(call.arguments || '{}') as Record<string, unknown>
                  } catch {
                    // Empty; the tool says what is missing.
                  }
                  const output = await useTool(api, turn, call.name ?? '', args)
                  send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(output) } })
                })
              ).then(() => send({ type: 'response.create' }))
              break
            }
          }
        }
        void (async () => {
          if (!input.spoken) {
            send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: input.text }] } })
            send({ type: 'response.create' })
            spokenEnd = Date.now()
            return
          }
          const pcm = await clip(input.text)
          for (let at = 0; at < pcm.length; at += 1920) {
            send({ type: 'input_audio_buffer.append', audio: pcm.subarray(at, at + 1920).toString('base64') })
            await sleep(10)
          }
          spokenEnd = Date.now()
          // The app's gate: 2 s of quiet at real time; the server's VAD ends the turn after 1.2 s.
          for (let quiet = 0; quiet < 2000; quiet += 40) {
            send({ type: 'input_audio_buffer.append', audio: Buffer.alloc(1920).toString('base64') })
            await sleep(40)
          }
        })()
      }),
    close: () => socket.close(1000)
  }
}

// ------------------------------------------------------------------ judge

interface Verdict {
  geslaagd: boolean
  juist: number
  behulpzaam: number
  beknopt: number
  nederlands: number
  initiatief: number
  verzonnen: boolean
  toelichting: string
}

let judgeUsd = 0

async function judge(scenario: Scenario, truth: string, turns: Turn[], opening: string | null): Promise<Verdict> {
  const transcript = [
    opening ? `[opening door het systeem]: ${opening}` : '',
    ...turns.map((turn, index) => {
      const tools = turn.tools.map((tool) => `${tool.name}(${JSON.stringify(tool.args).slice(0, 200)})${tool.error ? ` → FOUT: ${tool.error.slice(0, 120)}` : tool.result ? ` → ${tool.result}` : ''}`)
      return `Beurt ${index + 1}\nHidde: ${turn.said}${turn.heard && turn.heard.trim() !== turn.said ? ` (verstaan als: "${turn.heard.trim()}")` : ''}\nTools: ${tools.join('; ') || 'geen'}\nAssistent (uitgesproken): ${turn.reply.trim() || '(niets)'}`
    })
  ]
    .filter(Boolean)
    .join('\n\n')
  const prompt = `Je beoordeelt een Nederlandse spraakassistent ("Jarvis") die de agenda, taken en planning van Hidde beheert. De assistent praat; zijn antwoorden worden uitgesproken, dus lang voorlezen is slecht. Schrijf-acties horen een voorstel te zijn dat pas na Hiddes "ja" wordt uitgevoerd (via confirm).

Zo werkt dit systeem, beoordeel daarnaar:
- Een schrijvende tool (create_task, schedule_task, create_appointment, …) voert niets uit, maar maakt een voorstel. Een tool aanroepen en dan vragen "Zal ik dat zo doen?" is dus precies goed; pas confirm voert uit.
- Taken mogen over andere taken heen staan, ook over stageblokken van de planner. Alleen afspraken (vaste momenten met iemand of ergens) zijn harde grenzen.
- Wat een tool teruggeeft (achter de →) is waar: meldingstijden, vertrektijden en dergelijke uit een tool-uitkomst zijn geen verzinsels.
- De planner zet taken op de eerstvolgende vrije plek; een start iets later dan gevraagd omdat er iets anders staat is prima.

Datum en tijd nu: ${new Date().toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}.

Scenario: ${scenario.title}
Wat een goed antwoord doet: ${scenario.expect}
${truth ? `\nFeiten uit de database (de waarheid):\n${truth}\n` : ''}
Gesprek:
${transcript}

Geef een oordeel als JSON met precies deze velden:
- geslaagd (boolean): deed de assistent wat het scenario vraagt?
- juist (0-5): kloppen de genoemde feiten, tijden en datums? 5 = alles klopt.
- behulpzaam (0-5): helpt het Hidde echt verder?
- beknopt (0-5): geschikt om uit te spreken, zonder opvulling of herhaling? 5 = kort en to the point.
- nederlands (0-5): natuurlijk Nederlands, geen vreemde woorden of rare zinnen?
- initiatief (0-5): denkt hij mee voorbij de letterlijke vraag (risico's, botsingen, logische volgende stap) zonder te drammen? 3 = gewoon netjes.
- verzonnen (boolean): noemt hij iets als feit dat niet klopt of nergens uit volgt?
- toelichting (string): één of twee zinnen, concreet.`

  const first = await withRetry(() => judgeGemini(prompt))
  if (!SECOND_JUDGE) return first
  // A judge from another family: a Gemini judge might like Gemini's way of answering.
  const second = await withRetry(() => judgeOpenAI(prompt))
  const mean = (a: number, b: number): number => Math.round(((a + b) / 2) * 10) / 10
  return {
    geslaagd: first.geslaagd && second.geslaagd,
    juist: mean(first.juist, second.juist),
    behulpzaam: mean(first.behulpzaam, second.behulpzaam),
    beknopt: mean(first.beknopt, second.beknopt),
    nederlands: mean(first.nederlands, second.nederlands),
    initiatief: mean(first.initiatief, second.initiatief),
    // Only when both saw it: one judge alone flagged a benchmark mistake as made up before.
    verzonnen: first.verzonnen && second.verzonnen,
    toelichting: `G: ${first.toelichting} | O: ${second.toelichting}`
  }
}

/** JUDGES=2 adds the second judge (the challenge set always has it). */
const SECOND_JUDGE = process.env.JUDGES === '2' || process.env.SET === 'challenge'

const UNREADABLE = (why: string): Verdict => ({
  geslaagd: false,
  juist: 0,
  behulpzaam: 0,
  beknopt: 0,
  nederlands: 0,
  initiatief: 0,
  verzonnen: false,
  toelichting: `jury onleesbaar: ${why}`
})

/** A judge sometimes answers with nothing; ask again rather than score a zero. */
async function withRetry(ask: () => Promise<Verdict>): Promise<Verdict> {
  let verdict = UNREADABLE('geen poging')
  for (let attempt = 0; attempt < 3; attempt += 1) {
    verdict = await ask().catch((error: unknown) => UNREADABLE(error instanceof Error ? error.message : String(error)))
    if (!verdict.toelichting.startsWith('jury onleesbaar')) return verdict
  }
  return verdict
}

async function judgeGemini(prompt: string): Promise<Verdict> {
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', thinkingConfig: { thinkingLevel: 'low' } }
    })
  })
  const body = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number }
    error?: { message?: string }
  }
  const meta = body.usageMetadata ?? {}
  judgeUsd += ((meta.promptTokenCount ?? 0) * 0.75 + ((meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0)) * 3.75) / 1_000_000
  const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? ''
  try {
    return JSON.parse(text) as Verdict
  } catch {
    return UNREADABLE(body.error?.message ?? text.slice(0, 100))
  }
}

async function judgeOpenAI(prompt: string): Promise<Verdict> {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.4-mini', input: prompt, reasoning: { effort: 'low' }, text: { format: { type: 'json_object' } } })
  })
  const body = (await response.json()) as {
    output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>
    usage?: { input_tokens?: number; output_tokens?: number }
    error?: { message?: string }
  }
  judgeUsd += ((body.usage?.input_tokens ?? 0) * 0.75 + (body.usage?.output_tokens ?? 0) * 4.5) / 1_000_000
  const text = (body.output ?? [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .map((part) => part.text ?? '')
    .join('')
  try {
    return JSON.parse(text) as Verdict
  } catch {
    return UNREADABLE(body.error?.message ?? text.slice(0, 100))
  }
}

// ------------------------------------------------------------------- run

interface Result {
  provider: Provider
  scenario: string
  category: Scenario['category']
  family?: string
  title: string
  turns: Turn[]
  checks: Array<{ name: string; ok: boolean }>
  verdict: Verdict
  usd: number
  wastedTools: number
  toolErrors: number
  repeats: number
  error: string | null
}

const DUTCH = /\b(de|het|een|je|jij|en|is|op|van|morgen|vandaag|niet|staat|heb|hebt|om|uur|er|geen|wat|nog|dan|dat|met)\b/gi
const ENGLISH = /\b(the|you|and|will|let|know|your|have|of|to|there|tomorrow|today|what|with)\b/gi

/** Sentences said again in a later turn of the same conversation. */
function repeats(turns: Turn[]): number {
  const seen = new Set<string>()
  let count = 0
  for (const turn of turns) {
    const sentences = turn.reply
      .split(/[.!?]+/)
      .map((sentence) => sentence.trim().toLowerCase())
      .filter((sentence) => sentence.split(/\s+/).length >= 6)
    for (const sentence of sentences) if (seen.has(sentence)) count += 1
    for (const sentence of sentences) seen.add(sentence)
  }
  return count
}

async function runScenario(provider: Provider, scenario: Scenario): Promise<Result> {
  const api = freshApi()
  const result: Result = {
    provider,
    scenario: scenario.id,
    category: scenario.category,
    family: scenario.family,
    title: scenario.title,
    turns: [],
    checks: [],
    verdict: { geslaagd: false, juist: 0, behulpzaam: 0, beknopt: 0, nederlands: 0, initiatief: 0, verzonnen: false, toelichting: '' },
    usd: 0,
    wastedTools: 0,
    toolErrors: 0,
    repeats: 0,
    error: null
  }
  let driver: Driver | null = null
  try {
    await scenario.setup?.(api)
    const truth = (await scenario.truth?.(api)) ?? ''
    const opening = scenario.opening ? MOMENT[scenario.opening] : null
    driver =
      provider === 'gemini'
        ? await geminiDriver(api, opening)
        : isBrain(provider)
          ? await brainDriver(api, opening, provider)
          : await openaiDriver(api, opening, provider)
    const inputs = [...(opening ? [{ text: opening }] : []), ...scenario.turns]
    const offset = opening ? 1 : 0
    for (const [index, input] of inputs.entries()) {
      const turn = await driver.turn(input)
      result.turns.push(turn)
      for (const check of scenario.checks ?? []) {
        if (check.after + offset === index) result.checks.push({ name: check.name, ok: await check.test(api, result.turns).catch(() => false) })
      }
    }
    driver.close()
    driver = null
    result.verdict = await judge(scenario, truth, result.turns.slice(offset), opening)
    if (opening) result.verdict.toelichting = `${result.verdict.toelichting} [opening: "${result.turns[0]!.reply.trim().slice(0, 160)}"]`
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  } finally {
    driver?.close()
  }
  for (const turn of result.turns) result.usd += costOf(provider, turn.usage) + turn.extraUsd
  const calls = result.turns.reduce((sum, turn) => sum + turn.tools.length, 0)
  result.wastedTools = Math.max(0, calls - (scenario.toolBudget ?? 2))
  result.toolErrors = result.turns.reduce((sum, turn) => sum + turn.tools.filter((tool) => tool.error).length, 0)
  result.repeats = repeats(result.turns)
  return result
}

// --------------------------------------------------------------- report

/** Hidde talks 15–30 minutes a day: about 40–70 turns. */
const TURNS_PER_DAY = 55

const pct = (part: number, whole: number): string => (whole ? `${Math.round((part / whole) * 100)}%` : '–')
const avg = (values: number[]): number => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0)
const quantile = (values: number[], q: number): number => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
}

const turnUsd = (provider: Provider, turn: Turn): number => costOf(provider, turn.usage) + turn.extraUsd

/** A scenario passes when every hard check holds and the judge says it did the job. */
const passed = (result: Result): boolean => !result.error && result.checks.every((check) => check.ok) && result.verdict.geslaagd

function summary(results: Result[]): Record<string, string | number> {
  const turns = results.flatMap((result) => result.turns)
  const first = turns.map((turn) => turn.firstAudioMs).filter((value): value is number => value !== null)
  const checks = results.flatMap((result) => result.checks)
  const words = turns.map((turn) => turn.reply.trim().split(/\s+/).filter(Boolean).length)
  const usd = results.reduce((sum, result) => sum + result.usd, 0)
  const perTurn = turns.length ? usd / turns.length : 0
  const dutchTurns = turns.filter((turn) => (turn.reply.match(DUTCH)?.length ?? 0) > (turn.reply.match(ENGLISH)?.length ?? 0)).length
  const judged = results.filter((result) => !result.error)
  const byCategory = (category: Scenario['category']): string => {
    const own = results.filter((result) => result.category === category)
    return `${pct(own.filter(passed).length, own.length)} (${own.filter(passed).length}/${own.length})`
  }
  const input = turns.reduce((sum, turn) => sum + turn.usage.textIn + turn.usage.audioIn, 0)
  const cached = turns.reduce((sum, turn) => sum + (turn.usage.textInCached ?? 0) + (turn.usage.audioInCached ?? 0), 0)
  const score = avg(judged.map((result) => (result.verdict.juist + result.verdict.behulpzaam + result.verdict.beknopt + result.verdict.nederlands + result.verdict.initiatief) / 25))
  return {
    'geslaagd (totaal)': `${pct(results.filter(passed).length, results.length)} (${results.filter(passed).length}/${results.length})`,
    'geslaagd dagelijks': byCategory('dagelijks'),
    'geslaagd verder dan standaard': byCategory('verder'),
    ...Object.fromEntries(
      [...new Set(results.map((result) => result.family).filter((family): family is string => !!family))].map((family) => {
        const own = results.filter((result) => result.family === family)
        return [`  soort: ${family}`, `${pct(own.filter(passed).length, own.length)} (${own.filter(passed).length}/${own.length})`]
      })
    ),
    'harde checks ok': pct(checks.filter((check) => check.ok).length, checks.length),
    'jury: juist /5': avg(judged.map((result) => result.verdict.juist)).toFixed(2),
    'jury: behulpzaam /5': avg(judged.map((result) => result.verdict.behulpzaam)).toFixed(2),
    'jury: beknopt /5': avg(judged.map((result) => result.verdict.beknopt)).toFixed(2),
    'jury: Nederlands /5': avg(judged.map((result) => result.verdict.nederlands)).toFixed(2),
    'jury: initiatief /5': avg(judged.map((result) => result.verdict.initiatief)).toFixed(2),
    'jury: totaalscore': `${Math.round(score * 100)}%`,
    'verzonnen (scenario’s)': pct(judged.filter((result) => result.verdict.verzonnen).length, judged.length),
    'eerste geluid p50': `${(quantile(first, 0.5) / 1000).toFixed(2)} s`,
    'eerste geluid p90': `${(quantile(first, 0.9) / 1000).toFixed(2)} s`,
    'beurt klaar p50': `${(quantile(turns.map((turn) => turn.totalMs), 0.5) / 1000).toFixed(1)} s`,
    'woorden per antwoord': avg(words).toFixed(0),
    'spreekduur per antwoord': `${avg(turns.map((turn) => turn.audioSec)).toFixed(1)} s`,
    'tool-calls per beurt': avg(turns.map((turn) => turn.tools.length)).toFixed(2),
    'overbodige tool-calls': results.reduce((sum, result) => sum + result.wastedTools, 0),
    'tool-fouten': results.reduce((sum, result) => sum + result.toolErrors, 0),
    'herhaalde zinnen': results.reduce((sum, result) => sum + result.repeats, 0),
    'Nederlands (beurten)': pct(dutchTurns, turns.length),
    'time-outs / afgebroken': turns.filter((turn) => turn.problems.includes('time-out')).length + results.filter((result) => result.error).length,
    'input uit cache': pct(cached, input),
    'kosten totaal': `$${usd.toFixed(3)}`,
    'kosten per beurt': `$${perTurn.toFixed(4)}`,
    // Once the cache is warm: what a turn costs in a long conversation, the way Hidde talks.
    'kosten per vervolgbeurt (cache warm)': `${avg(results.flatMap((result) => result.turns.slice(1).map((turn) => turnUsd(result.provider, turn)))).toFixed(4)}`,
    'geschat per maand (cache warm)': `${(avg(results.flatMap((result) => result.turns.slice(1).map((turn) => turnUsd(result.provider, turn)))) * TURNS_PER_DAY * 30).toFixed(2)}`,
    'kosten per scenario': `$${(usd / Math.max(1, results.length)).toFixed(4)}`,
    // 15–30 minutes of talking a day is about 40–70 turns; 55 is the middle.
    'geschat per dag (55 beurten)': `$${(perTurn * TURNS_PER_DAY).toFixed(3)}`,
    'geschat per maand': `${(perTurn * TURNS_PER_DAY * 30).toFixed(2)}`,
    'score per dollar (maandgebruik)': perTurn ? ((score * 100) / (perTurn * TURNS_PER_DAY * 30)).toFixed(1) : '–'
  }
}

async function main(): Promise<void> {
  const providers = (process.env.ONLY ? process.env.ONLY.split(',').map((name) => name.trim()) : ['openai', 'gemini']) as Provider[]
  const wanted = process.env.SCENARIOS?.split(',').map((id) => id.trim().toUpperCase())
  const pool = process.env.SET === 'challenge' ? CHALLENGE : process.env.SET === 'samengesteld' ? COMPOUND : SCENARIOS
  const scenarios = wanted ? pool.filter((scenario) => wanted.some((id) => scenario.id.toUpperCase().startsWith(id))) : pool
  const budget: Record<Provider, number> = {
    openai: Number(process.env.BUDGET_OPENAI ?? 1.05),
    'openai-full': Number(process.env.BUDGET_OPENAI_FULL ?? 0.85),
    flash: Number(process.env.BUDGET_FLASH ?? 0.5),
    terra: Number(process.env.BUDGET_TERRA ?? 0.6),
    'gpt-mini': Number(process.env.BUDGET_GPT_MINI ?? 0.4),
    sonnet: Number(process.env.BUDGET_SONNET ?? 0.6),
    haiku: Number(process.env.BUDGET_HAIKU ?? 0.4),
    gemini: Number(process.env.BUDGET_GEMINI ?? 2.7)
  }
  const spent: Record<Provider, number> = { openai: 0, 'openai-full': 0, gemini: 0, flash: 0, terra: 0, 'gpt-mini': 0, sonnet: 0, haiku: 0 }
  const results: Result[] = []

  console.log(`Jarvis-benchmark: ${scenarios.length} scenario's × ${providers.join(' + ')}; budget ${providers.map((provider) => `${provider} $${budget[provider]}`).join(', ')}`)
  // Spoken lines first, so the TTS is not in any timing.
  for (const scenario of scenarios) for (const turn of scenario.turns) if (turn.spoken) await clip(turn.text)

  for (const scenario of scenarios) {
    for (const provider of providers) {
      if (spent[provider] >= budget[provider]) {
        console.log(`  ${provider}: budget op, ${scenario.id} overgeslagen`)
        continue
      }
      const result = await runScenario(provider, scenario)
      spent[provider] += result.usd
      results.push(result)
      const mark = passed(result) ? '✓' : '✗'
      const failedChecks = result.checks.filter((check) => !check.ok).map((check) => check.name)
      const first = result.turns.map((turn) => (turn.firstAudioMs === null ? '–' : `${(turn.firstAudioMs / 1000).toFixed(1)}s`)).join('/')
      console.log(
        `${mark} ${scenario.id} ${provider.padEnd(11)} ${scenario.title.padEnd(40)} jury ${result.verdict.juist}/${result.verdict.behulpzaam}/${result.verdict.beknopt}/${result.verdict.nederlands}/${result.verdict.initiatief}${result.verdict.verzonnen ? ' VERZONNEN' : ''}  geluid ${first}  $${result.usd.toFixed(4)}` +
          (failedChecks.length ? `\n     check mislukt: ${failedChecks.join(', ')}` : '') +
          (result.error ? `\n     FOUT: ${result.error}` : '') +
          `\n     ${result.verdict.toelichting}`
      )
      for (const turn of result.turns) {
        const tools = turn.tools.map((tool) => tool.name + (tool.error ? '!' : '')).join(',')
        console.log(`       · ${turn.said.slice(0, 60)} → [${tools}] ${turn.reply.trim().replace(/\s+/g, ' ').slice(0, 170)}${turn.problems.length ? ` {${turn.problems.join('; ')}}` : ''}`)
      }
    }
  }

  const table: Record<string, Record<string, string | number>> = {}
  for (const provider of providers) table[provider] = summary(results.filter((result) => result.provider === provider))
  const metrics = Object.keys(Object.values(table)[0] ?? {})
  console.log(`\n${'metric'.padEnd(44)}${providers.map((provider) => provider.padStart(18)).join('')}`)
  for (const metric of metrics) console.log(`${metric.padEnd(44)}${providers.map((provider) => String(table[provider]![metric]).padStart(18)).join('')}`)
  console.log(`\nJury (Gemini Flash) kostte $${judgeUsd.toFixed(3)}. Uitgegeven: ${providers.map((provider) => `${provider} $${spent[provider].toFixed(3)}`).join(', ')}.`)

  const out = join('node_modules', '.cache', 'uurwerk', `bench-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), table, results, judgeUsd }, null, 2))
  console.log(`Alles per beurt: ${out}`)
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
