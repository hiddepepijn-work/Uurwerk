/**
 * Jarvis live, end to end, before anything goes to the phone.
 *
 * Does what the app does, against the real Gemini Live: gets a token from the server code
 * (brief, tools and today locked in), connects with it, speaks real Dutch audio into the
 * microphone stream, runs the tools the model asks for on a copy of this laptop's database,
 * answers them the way the app does, and checks the replies: Dutch, and actually answering
 * rather than promising to come back.
 *
 *   npm run test:live
 *
 * Needs GEMINI_API_KEY, in the environment or in .env.local (git-ignored). Costs a few
 * cents per run. Writes nothing to the real database: the tools run on a temporary copy.
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GoogleGenAI, type LiveServerMessage, type Session } from '@google/genai'

import { createBackend } from '@backend/create.js'
import { installHost, unavailable, type Host } from '@backend/host.js'
import { buildImplementation } from '@backend/implementation.js'
import type { TimeTrackerAPI } from '@core/contract/api.js'
import { runTool } from '@core/services/jarvis-tools.js'

import { createJarvis, MOMENT, SYSTEM } from '../packages/server/app/jarvis/index.js'
import { addUsage, liveSession } from '../packages/server/app/jarvis/live.js'
import { usageListeners } from '../packages/server/app/jarvis/providers.js'
import { speakGemini } from '../packages/server/app/jarvis/speech.js'

// ------------------------------------------------------------------ setup

function geminiKey(): string {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim()
  if (existsSync('.env.local')) {
    const line = readFileSync('.env.local', 'utf8')
      .split(/\r?\n/)
      .find((entry) => entry.startsWith('GEMINI_API_KEY='))
    if (line) return line.slice('GEMINI_API_KEY='.length).trim()
  }
  throw new Error('Geen GEMINI_API_KEY: zet hem in .env.local (GEMINI_API_KEY=...) of in de omgeving.')
}

const work = mkdtempSync(join(tmpdir(), 'uurwerk-live-'))
const appData = process.env.APPDATA ?? join(process.env.USERPROFILE ?? '.', 'AppData', 'Roaming')
const realDb = join(appData, 'uurwerk', 'uurwerk', 'app.db')
const dbCopy = join(work, 'app.db')
if (existsSync(realDb)) copyFileSync(realDb, dbCopy)

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
const api = buildImplementation(createBackend(existsSync(dbCopy) ? dbCopy : ':memory:')) as unknown as TimeTrackerAPI

// ------------------------------------------------------------------ audio

/** Dutch speech as the phone would send it: 16 kHz 16-bit mono PCM. */
async function voice(key: string, text: string): Promise<Int16Array> {
  const wav = await speakGemini(text, key, 'Kore', 'gemini-3.8-flash-lite-tts')
  const pcm24 = new Int16Array(wav.buffer.slice(wav.byteOffset + 44, wav.byteOffset + wav.byteLength))
  const out = new Int16Array(Math.floor((pcm24.length * 2) / 3))
  for (let i = 0; i < out.length; i++) {
    const at = (i * 3) / 2
    const low = Math.floor(at)
    const high = Math.min(low + 1, pcm24.length - 1)
    out[i] = Math.round(pcm24[low]! + (pcm24[high]! - pcm24[low]!) * (at - low))
  }
  return out
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------- checks

const DUTCH = /\b(de|het|een|je|jij|en|is|op|van|morgen|vandaag|niet|staat|heb|hebt|om|uur|er|geen|wat|nog|dan|dat|met)\b/gi
const ENGLISH = /\b(the|you|and|will|let|know|your|have|is|of|to|there|tomorrow|today|what|with)\b/gi
const PROMISE = /(let you know|get back to you|kom (er )?(later )?(op )?terug|laat (het )?(je )?weten zodra)/i

interface Outcome {
  name: string
  reply: string
  tools: string[]
  firstAudioMs: number | null
  problems: string[]
}

interface Usage {
  textIn: number
  audioIn: number
  textOut: number
  audioOut: number
  thoughts: number
}

function judge(outcome: Outcome, expectTool: string | null): void {
  const dutch = outcome.reply.match(DUTCH)?.length ?? 0
  const english = outcome.reply.match(ENGLISH)?.length ?? 0
  if (!outcome.reply.trim()) outcome.problems.push('geen antwoord')
  else if (dutch <= english) outcome.problems.push(`niet Nederlands (nl ${dutch} / en ${english})`)
  if (PROMISE.test(outcome.reply)) outcome.problems.push('belooft later terug te komen')
  if (expectTool && !outcome.tools.includes(expectTool)) outcome.problems.push(`tool ${expectTool} niet gebruikt`)
}

// ------------------------------------------------------------- one round

/**
 * One exchange on an open session. Resolves once a turn completes with speech after every
 * tool call has been answered — the way the app would hear it.
 */
function exchange(session: Session, inbox: { handler: ((message: LiveServerMessage) => void) | null }, usage: Usage, send: () => Promise<void>, name: string): Promise<Outcome> {
  return new Promise((resolve) => {
    const outcome: Outcome = { name, reply: '', tools: [], firstAudioMs: null, problems: [] }
    let sentAt = 0
    let pendingTools = 0
    let spokeAfterTools = false
    let heardAudio = false
    const timer = setTimeout(() => {
      outcome.problems.push('time-out (30 s)')
      finish()
    }, 30_000)
    const finish = (): void => {
      clearTimeout(timer)
      inbox.handler = null
      resolve(outcome)
    }

    inbox.handler = (message) => {
      const content = message.serverContent
      if (content?.modelTurn?.parts?.some((part) => part.inlineData?.data)) {
        heardAudio = true
        if (outcome.firstAudioMs === null && sentAt) outcome.firstAudioMs = Date.now() - sentAt
        if (pendingTools === 0 && outcome.tools.length > 0) spokeAfterTools = true
      }
      if (content?.outputTranscription?.text) outcome.reply += content.outputTranscription.text
      if (message.usageMetadata) {
        const meta = message.usageMetadata
        for (const entry of meta.promptTokensDetails ?? []) {
          if (String(entry.modality) === 'TEXT') usage.textIn += entry.tokenCount ?? 0
          else usage.audioIn += entry.tokenCount ?? 0
        }
        for (const entry of meta.responseTokensDetails ?? []) {
          if (String(entry.modality) === 'TEXT') usage.textOut += entry.tokenCount ?? 0
          else usage.audioOut += entry.tokenCount ?? 0
        }
        usage.thoughts += meta.thoughtsTokenCount ?? 0
        if (process.env.LIVE_DEBUG) console.log('   usage', JSON.stringify({ prompt: meta.promptTokenCount, cached: meta.cachedContentTokenCount, cacheDetails: meta.cacheTokensDetails, response: meta.responseTokenCount, thoughts: meta.thoughtsTokenCount, tool: meta.toolUsePromptTokenCount }))
      }
      if (message.toolCall?.functionCalls?.length) {
        const calls = message.toolCall.functionCalls
        pendingTools += calls.length
        void Promise.all(
          calls.map(async (call) => {
            outcome.tools.push(call.name ?? '?')
            try {
              const result = await runTool(api, call.name ?? '', (call.args ?? {}) as Record<string, unknown>)
              return { id: call.id, name: call.name, response: { result } }
            } catch (error) {
              return { id: call.id, name: call.name, response: { error: String(error) } }
            }
          })
        ).then((responses) => {
          pendingTools -= responses.length
          session.sendToolResponse({ functionResponses: responses })
        })
      }
      if (content?.turnComplete && heardAudio && pendingTools === 0) {
        // IN_PROGRESS: that was "even kijken", the answer is still coming.
        const idle = String(content.interactionStatus ?? 'IDLE') !== 'IN_PROGRESS'
        if (idle && (outcome.tools.length === 0 || spokeAfterTools)) finish()
      }
    }

    void send().then(() => {
      sentAt = Date.now()
    })
  })
}

// ------------------------------------------------------------------- run

async function main(): Promise<void> {
  const key = geminiKey()
  const usagePath = join(work, 'spend.json')

  // A real open task from the copy, to plan in late in the evening where nothing else is.
  const tasks = await api.tasks.list({ status: 'active' })
  const task = tasks.find((entry) => /broeken/i.test(entry.title)) ?? tasks[0]
  if (!task) throw new Error('Geen open taak in de database om mee te testen.')
  const dayAfter = (days: number): string => {
    const d = new Date(Date.now() + days * 86_400_000)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  const placedAt = async (day: string): Promise<boolean> =>
    (await api.plans.day(day)).blocks.some((block) => block.taskId === task.id && block.startMin === 22 * 60)

  // ONLY=regressie skips the spoken scenarios (and their cost) and runs the regression test.
  const voiceToo = process.env.ONLY !== 'regressie'
  console.log(voiceToo ? 'Stem opnemen voor de testvragen…' : 'Alleen de regressietest.')
  const [tomorrow, today, schedule, yes] = voiceToo ? await Promise.all([
    voice(key, 'Wat staat er morgen op de planning?'),
    voice(key, 'Wat heb ik vandaag nog te doen?'),
    voice(key, `Zet ${task.title} morgen van tien uur tot half elf 's avonds in de planning.`),
    voice(key, 'Ja, doe maar.')
  ]) : [new Int16Array(0), new Int16Array(0), new Int16Array(0), new Int16Array(0)]

  const outcomes: Outcome[] = []
  const usage: Usage = { textIn: 0, audioIn: 0, textOut: 0, audioOut: 0, thoughts: 0 }

  async function connect(moment: 'morning' | 'evening' | null): Promise<{ session: Session; inbox: { handler: ((message: LiveServerMessage) => void) | null }; opening: string | null; closed: string[] }> {
    const started = Date.now()
    const live = await liveSession({ api, key, system: SYSTEM, voice: 'Orus', opening: moment ? MOMENT[moment] : null, usagePath })
    const inbox: { handler: ((message: LiveServerMessage) => void) | null } = { handler: null }
    const closed: string[] = []
    const ai = new GoogleGenAI({ apiKey: live.token, httpOptions: { apiVersion: live.apiVersion } })
    const session = await ai.live.connect({
      model: live.model,
      config: live.config,
      callbacks: {
        onmessage: (message) => inbox.handler?.(message),
        onerror: (event) => closed.push(`fout: ${event.message}`),
        onclose: (event) => {
          if (event.code !== 1000) closed.push(`gesloten ${event.code}: ${event.reason}`)
        }
      }
    })
    console.log(`Verbonden met ${live.model} in ${Date.now() - started} ms (token + verbinding).`)
    return { session, inbox, opening: live.opening, closed }
  }

  const speakInto = async (session: Session, pcm: Int16Array): Promise<void> => {
    // 40 ms chunks, then the 1.5 s of quiet the app's gate lets through, then "microphone
    // paused" — as the app does. Silence goes at real time: the model measures it.
    const chunk = (samples: Int16Array): void =>
      session.sendRealtimeInput({ audio: { data: Buffer.from(samples.buffer).toString('base64'), mimeType: 'audio/pcm;rate=16000' } })
    for (let at = 0; at < pcm.length; at += 640) {
      chunk(pcm.slice(at, at + 640))
      await sleep(10)
    }
    for (let quiet = 0; quiet < 1500; quiet += 40) {
      chunk(new Int16Array(640))
      await sleep(40)
    }
    session.sendRealtimeInput({ audioStreamEnd: true })
  }

  // 1 and 2: spoken questions, one conversation.
  if (voiceToo) {
    const { session, inbox, closed } = await connect(null)
    const first = await exchange(session, inbox, usage, () => speakInto(session, tomorrow), 'gesproken: morgen')
    // Tomorrow is in the snapshot: answering without a tool is the cheap, right way.
    judge(first, null)
    outcomes.push(first)
    const second = await exchange(session, inbox, usage, () => speakInto(session, today), 'gesproken: vandaag')
    judge(second, null)
    outcomes.push(second)
    for (const problem of closed) second.problems.push(problem)
    session.close()
  }

  // 3: the morning moment, opened by Jarvis himself.
  if (voiceToo) {
    const { session, inbox, opening, closed } = await connect('morning')
    const morning = await exchange(
      session,
      inbox,
      usage,
      async () => session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: opening ?? '' }] }], turnComplete: true }),
      'ochtendmoment'
    )
    judge(morning, null)
    for (const problem of closed) morning.problems.push(problem)
    outcomes.push(morning)
    session.close()
  }

  // 4: changing something by voice: a proposal, "ja", and then it is really there.
  if (voiceToo) {
    const { session, inbox, closed } = await connect(null)
    const proposal = await exchange(session, inbox, usage, () => speakInto(session, schedule), 'gesproken: inplannen (voorstel)')
    judge(proposal, 'schedule_task')
    if (!proposal.reply.includes('?')) proposal.problems.push('vraagt geen bevestiging')
    if (await placedAt(dayAfter(1))) proposal.problems.push('al ingepland vóór het ja')
    outcomes.push(proposal)
    const done = await exchange(session, inbox, usage, () => speakInto(session, yes), 'gesproken: ja')
    judge(done, 'confirm')
    if (!(await placedAt(dayAfter(1)))) done.problems.push('staat na het ja niet in de planning')
    for (const problem of closed) done.problems.push(problem)
    outcomes.push(done)
    session.close()
  }

  // 5: the same by text, through the server's Jarvis and its jobs.
  if (voiceToo) {
    process.env.JARVIS_MODEL ||= 'gemini-3.8-flash'
    const vault = { get: (name: string) => (name === 'geminiKey' ? key : null), has: (name: string) => name === 'geminiKey', set: () => undefined }
    const jarvis = createJarvis(api, vault as never, usagePath)
    const turn = async (name: string, input: { conversationId?: string | null; text: string }): Promise<{ outcome: Outcome; conversationId: string }> => {
      const started = Date.now()
      const { jobId } = await jarvis.askStart({ ...input, speak: false })
      let job = await jarvis.askJob(jobId)
      while (job.status === 'running') {
        await sleep(300)
        job = await jarvis.askJob(jobId)
      }
      const outcome: Outcome = { name, reply: job.reply?.text ?? '', tools: [], firstAudioMs: Date.now() - started, problems: job.error ? [job.error] : [] }
      return { outcome, conversationId: job.reply?.conversationId ?? '' }
    }
    const first = await turn('tekst: inplannen (voorstel)', { text: `Zet ${task.title} overmorgen van tien uur tot half elf 's avonds in de planning.` })
    judge(first.outcome, null)
    if (!first.outcome.reply.includes('?')) first.outcome.problems.push('vraagt geen bevestiging')
    if (await placedAt(dayAfter(2))) first.outcome.problems.push('al ingepland vóór het ja')
    outcomes.push(first.outcome)
    const second = await turn('tekst: ja', { conversationId: first.conversationId, text: 'Ja, doe maar.' })
    judge(second.outcome, null)
    if (!(await placedAt(dayAfter(2)))) second.outcome.problems.push('staat na het ja niet in de planning')
    outcomes.push(second.outcome)
  }

  // ---------------------------------------------------------- regression test
  // From the refactor plan, on a clean database of its own: Jarvis-planned stage work, two
  // private appointments by hand, and the requests that went wrong before.
  {
    process.env.JARVIS_MODEL ||= 'gemini-3.8-flash'
    const test = buildImplementation(createBackend(':memory:')) as unknown as TimeTrackerAPI
    const vault = { get: (name: string) => (name === 'geminiKey' ? key : null), has: (name: string) => name === 'geminiKey', set: () => undefined }
    const jarvis = createJarvis(test, vault as never, join(work, 'spend-regressie.json'))
    const perTurn: number[] = []
    let turnPrompt = 0
    usageListeners.push((entry) => {
      if (entry.round === 0) turnPrompt = entry.prompt
    })

    for (let weekday = 1; weekday <= 7; weekday++) {
      await test.availability.save({
        week: null,
        weekday,
        startMin: weekday <= 5 ? 9 * 60 : 10 * 60,
        endMin: 23 * 60,
        allowedAreas: [],
        areaTargets: {},
        stageStartMin: weekday <= 5 ? 9 * 60 : null,
        stageEndMin: weekday <= 5 ? 18 * 60 : null,
        enabled: true
      })
    }
    await test.tasks.create({ title: 'Architectuur onderzoek', areaId: 'stage', estimateMin: 900 })
    const bo = await test.tasks.create({ title: 'BO afmaken', areaId: 'school', estimateMin: 60 })
    const wbw = await test.tasks.create({ title: 'Wie betaald wat invullen', areaId: 'personal', estimateMin: 60 })
    const until = dayAfter(9)
    // What Jarvis planned before: the planner's blocks over the whole stretch.
    const seeded = (await runTool(test, 'plan_range', { from: dayAfter(0), to: until })) as { pendingId: string }
    await runTool(test, 'confirm', { pendingIds: [seeded.pendingId] })
    const tomorrowDay = dayAfter(1)
    const at = (day: string, time: string): number => new Date(`${day}T${time}:00`).getTime()
    for (const [title, end] of [['Kapper', '15:00'], ['Bellen met oma', '14:30']] as const) {
      await test.calendar.createEvent({
        title,
        startsAt: at(tomorrowDay, '14:00'),
        endsAt: at(tomorrowDay, end),
        areaId: 'personal',
        origin: 'uurwerk',
        classificationStatus: 'confirmed',
        includeInPlanning: true,
        registrationMode: 'none',
        countsAsWorked: false
      })
    }
    const events = async () => test.calendar.eventsInRange(at(dayAfter(0), '00:00'), at(until, '23:59'))
    const allBlocks = async () => {
      const blocks = []
      for (let offset = 0; offset <= 9; offset++) blocks.push(...(await test.plans.day(dayAfter(offset))).blocks)
      return blocks
    }

    const ask = async (name: string, text: string, conversationId: string | null, dropFor = 0) => {
      const started = Date.now()
      const { jobId } = await jarvis.askStart({ text, conversationId, speak: false })
      // dropFor: the phone loses the connection and asks nothing for a while.
      if (dropFor > 0) await sleep(dropFor)
      let job = await jarvis.askJob(jobId)
      while (job.status === 'running') {
        await sleep(300)
        job = await jarvis.askJob(jobId)
      }
      perTurn.push(turnPrompt)
      const outcome: Outcome = { name, reply: job.reply?.text ?? '', tools: [], firstAudioMs: Date.now() - started, problems: job.error ? [job.error] : [] }
      judge(outcome, null)
      outcomes.push(outcome)
      return { outcome, conversationId: job.reply?.conversationId ?? null }
    }

    // 1. Everything away except the two private appointments, and replan until …
    const dateWords = new Date(`${until}T12:00:00`).toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' })
    const blocksBefore = (await allBlocks()).length
    const r1 = await ask('regressie 1: voorstel', `Haal alles weg behalve de twee privé-afspraken en plan opnieuw tot ${dateWords}.`, null)
    if (!r1.outcome.reply.includes('?')) r1.outcome.problems.push('vraagt geen bevestiging')
    if ((await allBlocks()).length !== blocksBefore || (await events()).length !== 2) r1.outcome.problems.push('iets veranderd vóór het ja')
    const r1b = await ask('regressie 1+2: ja, verbinding 12 s weg', 'Ja, doe maar.', r1.conversationId, 12_000)
    const afterEvents = await events()
    if (afterEvents.length !== 2) r1b.outcome.problems.push(`privé-afspraken: ${afterEvents.length} over in plaats van 2`)
    const blocks = (await allBlocks()).filter((entry) => entry.kind === 'task')
    const stage = blocks.filter((entry) => entry.areaId === 'stage')
    const weekend = stage.filter((entry) => [0, 6].includes(new Date(`${entry.date}T12:00:00`).getDay()))
    if (weekend.length > 0) r1b.outcome.problems.push(`${weekend.length} stageblokken in het weekend`)
    if (stage.some((entry) => entry.startMin < 9 * 60 || entry.endMin > 18 * 60)) r1b.outcome.problems.push('stage buiten de stage-uren')
    if (stage.length === 0) r1b.outcome.problems.push('niets opnieuw gepland')
    if (!/\d|een|twee|drie|vier|vijf|zes|zeven|acht|negen|tien|elf|twaalf/i.test(r1b.outcome.reply)) r1b.outcome.problems.push('noemt geen aantallen')

    // 3. Two tasks one after another after tomorrow's appointments, no overlap.
    const r3 = await ask(
      'regressie 3: voorstel',
      'Zet BO afmaken en Wie betaald wat invullen morgen achter elkaar na mijn afspraken van 14:00, allebei 1 uur.',
      r1b.conversationId
    )
    if (!r3.outcome.reply.includes('?')) r3.outcome.problems.push('vraagt geen bevestiging')
    const r3b = await ask('regressie 3: ja', 'Ja.', r3.conversationId)
    const placed = (await test.plans.day(tomorrowDay)).blocks.filter((entry) => entry.taskId === bo.id || entry.taskId === wbw.id)
    if (placed.length < 2) r3b.outcome.problems.push(`${placed.length} van de 2 taken ingepland morgen`)
    for (const entry of placed) {
      for (const event of afterEvents) {
        const from = Math.round((event.startsAt - at(tomorrowDay, '00:00')) / 60_000)
        const to = Math.round((event.endsAt - at(tomorrowDay, '00:00')) / 60_000)
        if (entry.startMin < to && entry.endMin > from) r3b.outcome.problems.push(`${entry.taskTitle} overlapt met ${event.title}`)
      }
    }

    // 5. Twenty messages: the prompt per request stays about flat.
    const questions = [
      'Hoe laat is het?', 'Wat heb ik morgen?', 'Welke taken zijn te laat?', 'Wat staat er overmorgen?',
      'Hoeveel stage heb ik deze week?', 'Wat doe ik vanavond?', 'Heb ik vrijdag afspraken?', 'Wat is mijn drukste dag?',
      'Hoe lang duurt BO afmaken?', 'Wat heb ik zaterdag?', 'Wanneer is de kapper?', 'Wat staat er donderdag?',
      'Wat moet ik als eerste doen?', 'Heb ik zondag iets?', 'Wat staat er morgenochtend?', 'Hoeveel open taken heb ik?'
    ]
    let conversation = r3b.conversationId
    const flatStart = perTurn.length
    const flatOutcomes: Outcome[] = []
    for (const question of questions) {
      const result = await ask(`20 berichten: ${question}`, question, conversation)
      conversation = result.conversationId
      flatOutcomes.push(result.outcome)
    }
    const series = perTurn.slice(flatStart)
    const early = Math.max(...series.slice(2, 6))
    const late = Math.max(...series.slice(-5))
    const last = flatOutcomes[flatOutcomes.length - 1]!
    last.name = `regressie 5: tokens per verzoek vroeg ${early}, laat ${late}`
    if (late > early * 1.35) last.problems.push(`groeit mee: ${early} → ${late}`)
  }

  const spend = addUsage(usagePath, usage)
  console.log('')
  for (const outcome of outcomes) {
    const mark = outcome.problems.length === 0 ? '✓' : '✗'
    console.log(`${mark} ${outcome.name}  (eerste geluid ${outcome.firstAudioMs ?? '–'} ms, tools: ${outcome.tools.join(', ') || 'geen'})`)
    console.log(`    “${outcome.reply.trim().slice(0, 300)}”`)
    for (const problem of outcome.problems) console.log(`    ! ${problem}`)
  }
  console.log(`\nKosten van deze run: $${spend.usd.toFixed(4)}  (${JSON.stringify(usage)})`)

  rmSync(work, { recursive: true, force: true })
  if (outcomes.some((outcome) => outcome.problems.length > 0)) process.exit(1)
  process.exit(0)
}

main().catch((error: unknown) => {
  console.error('✗', error instanceof Error ? error.message : error)
  rmSync(work, { recursive: true, force: true })
  process.exit(1)
})
