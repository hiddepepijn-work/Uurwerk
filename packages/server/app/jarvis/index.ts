/**
 * ★ Jarvis. ★
 *
 * The brief in docs/jarvis.md is his standing instruction; the tools are the app's own API;
 * the model and the voice are settings on the server:
 *
 *   JARVIS_MODEL     gemini-3.8-flash | mistral-medium-latest | gpt-6-luna | claude-opus-5 | …
 *                    — the prefix picks the provider and the key it needs
 *   JARVIS_EFFORT    low (default) | medium | high — thinking per turn
 *   JARVIS_EFFORT_BIG  medium (default) — for replanning asks
 *   AZURE_SPEECH_REGION  westeurope (default)
 *   secrets.json     geminiKey / mistralKey / openaiKey / anthropicKey, azureSpeechKey
 *                    (bin/uurwerk-secrets.js). Without an Azure key: the free Edge voice.
 *
 * Conversations live in memory for two hours: long enough for the morning's back-and-forth,
 * short enough that tomorrow starts fresh.
 */

import { randomUUID } from 'node:crypto'

import type { JarvisAsk, JarvisJob, JarvisReply, JarvisStatus, TimeTrackerAPI } from '@core/contract/api.js'
import type { SecretVault } from '@backend/host.js'
import { log } from '@backend/log.js'

import brief from '../../../../docs/jarvis.md'
import { briefForModel } from './brief.js'
import { claude, compatible, openai, usageListeners, type Conversation, type Effort, type Provider } from './providers.js'
import { effortFor } from './effort.js'
import { addTextUsage, addUsage, liveSession, readSpend } from './live.js'
import { speak, speakFree, speakGemini } from './speech.js'
import { runTool } from '@core/services/jarvis-tools.js'

/**
 * A conversation ends after half an hour of silence, and at the end of the day: the next
 * one starts clean, from the database and the day's summary, not from an ever longer chat.
 */
const IDLE_MS = 30 * 60_000

export const SYSTEM = `Je bent Jarvis, de assistent van Hidde in de app Uurwerk. Hieronder staat je brief: wie
Hidde is, wat je doet op welke momenten, wat je altijd vraagt en wat je wel en niet mag.
Volg die precies.

Regels voor elk antwoord:
- Je antwoord wordt voorgelezen. Schrijf gesproken Nederlands: korte zinnen, geen opmaak,
  geen lijstjes met streepjes, geen emoji. Tijden als "half negen" of "18:25" is allebei goed.
- Maximaal een paar zinnen per beurt. Stel één vraag tegelijk.
- Elk bericht begint met de stand van nu: vandaag en morgen, de open en te late taken en de
  regels (de snapshot). Andere dagen haal je op met get_snapshot, details met get_agenda.
  Verzin nooit een afspraak, taak of tijd. De kenmerken t:… en a:… gebruik je als id.
- Iets veranderen gaat in twee stappen. De schrijvende tools (create_task, update_task,
  schedule_task, plan_range, clear_planning, create_appointment, move_appointment,
  delete_appointment, start_timer, stop_timer) voeren niets uit: ze maken een voorstel. Zet alles
  wat bij één verzoek hoort in voorstellen, vat ze samen en vraag "Zal ik dat zo doen?".
  Bij een duidelijk ja: confirm. Bij nee of iets anders: cancel.
- Na confirm vertel je precies wat confirm teruggeeft: wat gelukt is, met de echte aantallen,
  en wat mislukte. Zeg nooit dat iets staat als confirm dat niet zegt.
- Afspraak of taak: bepaal dat altijd eerst, en zeg het als je twijfelt.
  AFSPRAAK = een vast moment met iemand of ergens, dat doorgaat of Hidde nu wil of niet:
  kapper, tandarts, bellen met oma om 14:00, overleg met Tessie, eten bij Juul, stagedag op
  locatie. Afspraken staan in de agenda (create_appointment), krijgen reistijd en meldingen
  30 en 15 minuten vooraf, en de planner plant eromheen: ze schuiven nooit vanzelf.
  TAAK = werk dat Hidde zelf doet, met een duur: BO afmaken, financiën regelen, kast fixen,
  wie betaalt wat invullen, app verder ontwikkelen. Een taak is een taak (create_task) en
  krijgt blokken in de planning; ook als Hidde er een tijd bij noemt ("zet BO om 20:00") is
  het een taakblok (schedule_task), nooit een afspraak. Taken mogen door elkaar heen staan;
  meld het als een blok over een andere taak valt.
- Taken plan je nooit zelf blok voor blok. Eén taak op een genoemd tijdstip: schedule_task.
  Taken "achter elkaar", "na mijn afspraken", "ergens vanavond": propose_plan met alleen de
  taken, de minuten en het venster; de code zoekt de plekken. Een hele periode: plan_range.
- "Voortaan …" of "nooit meer …" is een vaste regel: add_rule (stage-dagen en -uren als
  stage_window, al het andere als note). Een regel wijzigen of uitzetten: update_rule.
- "Haal de planning weg en plan opnieuw tot …" is één plan_range: die vervangt wat de planner
  eerder zette en laat afspraken en handmatige blokken staan. De planner kent de harde
  regels (stage alleen ma-vr binnen de stage-uren); plan zelf nooit stage in het weekend.
- Alles wat je bij een nieuwe afspraak of taak hoort, gaat in de notitie.
- Sluit de dagafsluiting af met note_day_summary: twee of drie zinnen over hoe de dag ging
  en wat morgen telt. Het volgende gesprek begint daarmee.

--- BRIEF ---
${briefForModel(brief)}`

export const MOMENT: Record<'morning' | 'evening', string> = {
  morning:
    '(Ochtendmoment, 08:30. Hidde heeft op de melding getikt. Begin het ochtendgesprek zoals in de brief: de stand van vandaag staat in de snapshot; noem wat vastligt, wat te laat is en hoe laat hij weg moet, en vraag wat hij vandaag gaat doen.)',
  evening:
    '(Dagafsluiting, 21:00. Hidde heeft op de melding getikt. Doe de dagafsluiting zoals in de brief: day_review van vandaag, zeg wat af is en wat niet — streng —, vraag waarom en wanneer het wel gebeurt, vraag hoe het ging met opruimen achter zichzelf aan en zijn andere structuurgewoontes (één vraag tegelijk), vraag naar extra afspraken, noem kort wat morgen vastligt, en sluit af met note_day_summary.)'
}

interface Live {
  conversation: Conversation
  lastUsed: number
  /** The day it started: a new day is a new conversation. */
  day: string
  /** Nothing sent yet: the first message carries the summary to start from. */
  fresh: boolean
}

export function createJarvis(
  api: TimeTrackerAPI,
  secrets: SecretVault,
  /** Where this month's live spend is kept. */
  usagePath: string
): TimeTrackerAPI['jarvis'] {
  const conversations = new Map<string, Live>()
  const model = process.env.JARVIS_MODEL?.trim() || 'claude-opus-5'
  // Low for everyday questions; replanning ("plan de week opnieuw") thinks harder.
  const effort = (process.env.JARVIS_EFFORT as Effort | undefined) ?? 'low'
  const bigEffort = (process.env.JARVIS_EFFORT_BIG as Effort | undefined) ?? 'medium'
  const region = process.env.AZURE_SPEECH_REGION?.trim() || 'westeurope'
  /** Gemini voice (Kore, Charon, Orus, Aoede, …) and its model; used whenever there is a Gemini key. */
  const voice = process.env.JARVIS_VOICE?.trim() || 'Orus'
  const ttsModel = process.env.JARVIS_TTS_MODEL?.trim() || 'gemini-3.8-flash-tts'
  /** When the model is busy or out of free quota: the next ones, in order. */
  const fallbacks = (process.env.JARVIS_FALLBACK_MODELS ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)
  const family = /^gemini/i.test(model)
    ? 'gemini'
    : /^(mistral|magistral|ministral)/i.test(model)
      ? 'mistral'
      : /^(gpt|o\d)/i.test(model)
        ? 'openai'
        : 'anthropic'
  const keyName = ({ gemini: 'geminiKey', mistral: 'mistralKey', openai: 'openaiKey', anthropic: 'anthropicKey' } as const)[
    family
  ]

  const provider = (): Provider => {
    const key = secrets.get(keyName)
    if (!key) throw new Error(`Geen ${keyName} op de server. Zet hem met: uurwerk-secrets set ${keyName}`)
    switch (family) {
      case 'gemini':
        return compatible('gemini', 'https://generativelanguage.googleapis.com/v1beta/openai/', key, model, effort, fallbacks)
      case 'mistral':
        return compatible('mistral', 'https://api.mistral.ai/v1', key, model, null)
      case 'openai':
        return openai(key, model, effort)
      default:
        return claude(key, model, effort)
    }
  }

  /**
   * The state of the day for the newest message: the time, the snapshot (today and tomorrow,
   * tasks, rules), and for a fresh conversation the latest summary to start from.
   */
  const context = async (fresh: boolean): Promise<string> => {
    const now = new Date()
    const lines = [
      `Nu: ${now.toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, ${now.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}`
    ]
    const snapshot = await runTool(api, 'get_snapshot', {}).catch(() => null)
    if (typeof snapshot === 'string') lines.push(snapshot)
    if (fresh) {
      const log = (await api.assistant.dayLog(today())).summary
        ? await api.assistant.dayLog(today())
        : await api.assistant.lastSummary(today())
      if (log?.summary) lines.push('', `Samenvatting ${log.date}: ${log.summary}`)
    }
    return lines.join('\n')
  }

  // ------------------------------------------------------------ the day's opening
  // The first contact of the day opens with the morning conversation. The day log in the
  // database says whether that happened, on every copy.
  const today = (): string => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  }
  const markMoment = async (moment: 'morning' | 'evening' | null | undefined): Promise<void> => {
    if (moment === 'morning') await api.assistant.markDay(today(), { opening: true })
    if (moment === 'evening') await api.assistant.markDay(today(), { closing: true })
  }
  /** Before two in the afternoon; later than that a morning conversation is no use. */
  const openingDue = async (): Promise<boolean> =>
    new Date().getHours() < 14 && (await api.assistant.dayLog(today())).openingDoneAt === null

  // --------------------------------------------------------------------- jobs
  // A turn can take half a minute when he replans. On a phone that is long enough for the
  // connection to drop; the job carries on here and the phone asks how it went.
  const jobs = new Map<string, JarvisJob & { at: number }>()

  // Typed Jarvis counts towards the month as well: every model call reports its tokens.
  usageListeners.push((entry) => {
    if (/^gemini/i.test(entry.model)) addTextUsage(usagePath, entry)
  })

  const jarvis: TimeTrackerAPI['jarvis'] = {
    async askStart(input) {
      for (const [id, job] of jobs) if (Date.now() - job.at > 15 * 60_000) jobs.delete(id)
      const jobId = randomUUID()
      jobs.set(jobId, { status: 'running', reply: null, error: null, at: Date.now() })
      void jarvis.ask(input).then(
        (reply) => jobs.set(jobId, { status: 'done', reply, error: null, at: Date.now() }),
        (error: unknown) => {
          log.warn('A Jarvis job failed.', error)
          jobs.set(jobId, { status: 'failed', reply: null, error: error instanceof Error ? error.message : String(error), at: Date.now() })
        }
      )
      return { jobId }
    },

    async askJob(jobId) {
      const job = jobs.get(jobId)
      if (!job) return { status: 'failed', reply: null, error: 'Dit antwoord is niet meer bekend op de server. Vraag het opnieuw.' }
      return { status: job.status, reply: job.reply, error: job.error }
    },

    async status(): Promise<JarvisStatus> {
      const keyPresent = secrets.has(keyName)
      return {
        openingDue: await openingDue(),
        spend: readSpend(usagePath),
        ready: keyPresent,
        provider: family,
        model,
        // Always a voice: Azure with a key, the free Edge voice without.
        voice: true,
        problem: keyPresent ? null : `${keyName} staat nog niet op de server.`
      }
    },

    async ask(input: JarvisAsk): Promise<JarvisReply> {
      for (const [id, live] of conversations) {
        if (Date.now() - live.lastUsed > IDLE_MS || live.day !== today()) conversations.delete(id)
      }

      let id = input.conversationId ?? null
      let live = id ? conversations.get(id) : undefined
      if (!live || input.moment) {
        id = randomUUID()
        live = { conversation: provider().start(SYSTEM), lastUsed: Date.now(), day: today(), fresh: true }
        conversations.set(id, live)
      }
      live.lastUsed = Date.now()

      const said = input.moment ? MOMENT[input.moment] : (input.text ?? '').trim()
      await markMoment(input.moment)
      if (!said) throw new Error('Zeg iets tegen Jarvis.')

      const fresh = live.fresh
      live.fresh = false
      const turn = await live.conversation.send(said, await context(fresh), (name, args) => runTool(api, name, args), {
        kind: input.moment ?? 'text',
        effort: effortFor(input.text, effort, bigEffort)
      })

      let audio: string | null = null
      let audioType: string | null = null
      if (input.speak !== false) {
        // Best voice first: Gemini (natural), then Azure, then the free Edge voice.
        const geminiKey = secrets.get('geminiKey')
        const azureKey = secrets.get('azureSpeechKey')
        const attempts: Array<[string, () => Promise<Uint8Array>]> = []
        if (geminiKey) {
          attempts.push(['audio/wav', () => speakGemini(turn.text, geminiKey, voice, ttsModel)])
          // Its own daily quota: the same voice when the first model's hundred a day are used.
          attempts.push(['audio/wav', () => speakGemini(turn.text, geminiKey, voice, 'gemini-3.8-flash-lite-tts')])
        }
        if (azureKey) attempts.push(['audio/mpeg', () => speak(turn.text, azureKey, region)])
        attempts.push(['audio/mpeg', () => speakFree(turn.text)])
        for (const [type, attempt] of attempts) {
          try {
            audio = Buffer.from(await attempt()).toString('base64')
            audioType = type
            break
          } catch (error) {
            log.warn('A voice failed; trying the next.', error)
          }
        }
      }

      return { conversationId: id!, text: turn.text, audio, audioType, changed: turn.changed }
    },

    async liveSession(input) {
      const key = secrets.get('geminiKey')
      if (!key) throw new Error('Geen geminiKey op de server. Zet hem met: uurwerk-secrets set geminiKey')
      await markMoment(input.moment)
      return liveSession({
        api,
        key,
        system: SYSTEM,
        voice,
        opening: input.moment && !input.resume ? MOMENT[input.moment] : null,
        usagePath,
        resume: input.resume ?? null
      })
    },

    async runTool(input) {
      return runTool(api, input.name, input.args)
    },

    async clientLog(input) {
      const device = String(input.device ?? '?').slice(0, 20)
      for (const line of (input.lines ?? []).slice(-40)) log.info(`Jarvis on ${device}: ${String(line).slice(0, 300)}`)
    },

    async liveUsage(input) {
      const spend = addUsage(usagePath, input)
      // Live reports per conversation (the device adds up its turns), not per request.
      log.info('Jarvis usage.', { model: process.env.JARVIS_LIVE_MODEL?.trim() || 'gemini-3.8-live-extended-thinking', kind: 'live-session', ...input })
      log.info('Jarvis live spend.', spend)
      return spend
    }
  }
  return jarvis
}
