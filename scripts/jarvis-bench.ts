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
import { liveSession, openaiSession, usageUsd } from '../packages/server/app/jarvis/live.js'
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
  const proposed = (await runTool(api, 'create_appointment', { title, date, start, end, areaId })) as { pendingId?: string; error?: string }
  if (!proposed.pendingId) throw new Error(`setup: ${proposed.error ?? 'geen voorstel'}`)
  await runTool(api, 'confirm', { pendingIds: [proposed.pendingId] })
}

// -------------------------------------------------------------- scenarios

interface Check {
  /** After which turn (0-based) this is checked. */
  after: number
  name: string
  test: (api: TimeTrackerAPI) => Promise<boolean>
}

interface Scenario {
  id: string
  category: 'dagelijks' | 'verder'
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
    turns: [{ text: 'Ik heb donderdag om drie uur een afspraak bij de tandarts, duurt een half uur.' }, { text: 'Ja.' }],
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
      'Zet BO afmaken (60 min), Financiën regelen (45 min) en Kamer opruimen (30 min) morgenavond na 17:00 in, niet tijdens de voetbaltraining 19:00–20:00, stelt het als één voorstel voor en voert uit na ja.',
    setup: async (api) => {
      await api.tasks.create({ title: 'Financiën regelen', areaId: 'personal', estimateMin: 45 })
      await api.tasks.create({ title: 'Kamer opruimen', areaId: 'personal', estimateMin: 30 })
      if (!(await taskNamed(api, /BO afmaken/i))) await api.tasks.create({ title: 'BO afmaken', areaId: 'school', estimateMin: 60 })
      await appointment(api, 'Voetbaltraining', TOMORROW, '19:00', '20:00')
    },
    turns: [
      { text: 'Plan morgenavond na mijn stage BO afmaken, financiën regelen en kamer opruimen in. Niet tijdens de training.' },
      { text: 'Ja, prima.' }
    ],
    checks: [
      {
        after: 1,
        name: 'drie blokken na 17:00, niet in 19–20',
        test: async (api) => {
          const blocks = [
            ...(await blocksOn(api, TOMORROW, /BO afmaken/i)),
            ...(await blocksOn(api, TOMORROW, /financi/i)),
            ...(await blocksOn(api, TOMORROW, /kamer/i))
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
    turns: [{ text: 'Voeg een taak band plakken toe, en ik heb vrijdag om twee uur de huisarts, twintig minuten.' }, { text: 'Ja, allebei.' }],
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

type Provider = 'openai' | 'openai-full' | 'gemini'

const MODEL: Record<Provider, string> = {
  openai: 'gpt-realtime-2.1-mini',
  'openai-full': 'gpt-realtime-2.1',
  gemini: 'gemini-3.8-live-extended-thinking'
}
const costOf = (provider: Provider, usage: JarvisLiveUsage): number => usageUsd(usage, MODEL[provider])

interface ToolUse {
  name: string
  args: Record<string, unknown>
  error: string | null
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
  problems: string[]
}

interface Driver {
  turn(input: { text: string; spoken?: boolean }): Promise<Turn>
  close(): void
}

const blankUsage = (provider: Provider): JarvisLiveUsage => ({
  provider: provider === 'gemini' ? 'gemini' : 'openai',
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
    turn.tools.push({ name, args, error })
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
      const tools = turn.tools.map((tool) => `${tool.name}(${JSON.stringify(tool.args).slice(0, 200)})${tool.error ? ` → FOUT: ${tool.error.slice(0, 120)}` : ''}`)
      return `Beurt ${index + 1}\nHidde: ${turn.said}${turn.heard && turn.heard.trim() !== turn.said ? ` (verstaan als: "${turn.heard.trim()}")` : ''}\nTools: ${tools.join('; ') || 'geen'}\nAssistent (uitgesproken): ${turn.reply.trim() || '(niets)'}`
    })
  ]
    .filter(Boolean)
    .join('\n\n')
  const prompt = `Je beoordeelt een Nederlandse spraakassistent ("Jarvis") die de agenda, taken en planning van Hidde beheert. De assistent praat; zijn antwoorden worden uitgesproken, dus lang voorlezen is slecht. Schrijf-acties horen een voorstel te zijn dat pas na Hiddes "ja" wordt uitgevoerd (via confirm).

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
    return { geslaagd: false, juist: 0, behulpzaam: 0, beknopt: 0, nederlands: 0, initiatief: 0, verzonnen: false, toelichting: `jury onleesbaar: ${body.error?.message ?? text.slice(0, 100)}` }
  }
}

// ------------------------------------------------------------------- run

interface Result {
  provider: Provider
  scenario: string
  category: Scenario['category']
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
    driver = provider === 'gemini' ? await geminiDriver(api, opening) : await openaiDriver(api, opening, provider)
    const inputs = [...(opening ? [{ text: opening }] : []), ...scenario.turns]
    const offset = opening ? 1 : 0
    for (const [index, input] of inputs.entries()) {
      const turn = await driver.turn(input)
      result.turns.push(turn)
      for (const check of scenario.checks ?? []) {
        if (check.after + offset === index) result.checks.push({ name: check.name, ok: await check.test(api).catch(() => false) })
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
  for (const turn of result.turns) result.usd += costOf(provider, turn.usage)
  const calls = result.turns.reduce((sum, turn) => sum + turn.tools.length, 0)
  result.wastedTools = Math.max(0, calls - (scenario.toolBudget ?? 2))
  result.toolErrors = result.turns.reduce((sum, turn) => sum + turn.tools.filter((tool) => tool.error).length, 0)
  result.repeats = repeats(result.turns)
  return result
}

// --------------------------------------------------------------- report

const pct = (part: number, whole: number): string => (whole ? `${Math.round((part / whole) * 100)}%` : '–')
const avg = (values: number[]): number => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0)
const quantile = (values: number[], q: number): number => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
}

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
    'kosten per scenario': `$${(usd / Math.max(1, results.length)).toFixed(4)}`,
    'geschat per dag (2 gesprekken × 6 beurten)': `$${(perTurn * 12).toFixed(3)}`,
    'geschat per maand': `$${(perTurn * 12 * 30).toFixed(2)}`,
    'score per dollar (maandgebruik)': perTurn ? (score * 100 / (perTurn * 12 * 30)).toFixed(0) : '–'
  }
}

async function main(): Promise<void> {
  const providers = (process.env.ONLY ? process.env.ONLY.split(',').map((name) => name.trim()) : ['openai', 'gemini']) as Provider[]
  const wanted = process.env.SCENARIOS?.split(',').map((id) => id.trim().toUpperCase())
  const scenarios = wanted ? SCENARIOS.filter((scenario) => wanted.includes(scenario.id)) : SCENARIOS
  const budget: Record<Provider, number> = {
    openai: Number(process.env.BUDGET_OPENAI ?? 1.05),
    'openai-full': Number(process.env.BUDGET_OPENAI_FULL ?? 0.85),
    gemini: Number(process.env.BUDGET_GEMINI ?? 2.7)
  }
  const spent: Record<Provider, number> = { openai: 0, 'openai-full': 0, gemini: 0 }
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
