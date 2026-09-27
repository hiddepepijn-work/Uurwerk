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
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { JarvisAsk, JarvisJob, JarvisReply, JarvisStatus, TimeTrackerAPI } from '@core/contract/api.js'
import type { SecretVault } from '@backend/host.js'
import { log } from '@backend/log.js'

import brief from '../../../../docs/jarvis.md'
import { claude, compatible, openai, type Conversation, type Effort, type Provider } from './providers.js'
import { effortFor } from './effort.js'
import { addUsage, liveSession } from './live.js'
import { speak, speakFree, speakGemini } from './speech.js'
import { runTool } from '@core/services/jarvis-tools.js'

const IDLE_MS = 2 * 3_600_000

export const SYSTEM = `Je bent Jarvis, de assistent van Hidde in de app Uurwerk. Hieronder staat je brief: wie
Hidde is, wat je doet op welke momenten, wat je altijd vraagt en wat je wel en niet mag.
Volg die precies.

Regels voor elk antwoord:
- Je antwoord wordt voorgelezen. Schrijf gesproken Nederlands: korte zinnen, geen opmaak,
  geen lijstjes met streepjes, geen emoji. Tijden als "half negen" of "18:25" is allebei goed.
- Maximaal een paar zinnen per beurt. Stel één vraag tegelijk.
- Haal feiten op met je tools (get_now, get_agenda, list_tasks, day_review) voordat je
  iets over de agenda of taken zegt. Verzin nooit een afspraak, taak of tijd.
- Iets veranderen gaat in twee stappen. De schrijvende tools (create_task, update_task,
  schedule_task, plan_range, clear_planning, create_appointment, move_appointment,
  delete_appointment, apply_day_plan, start_timer, stop_timer) voeren niets uit: ze maken een voorstel. Zet alles
  wat bij één verzoek hoort in voorstellen, vat ze samen en vraag "Zal ik dat zo doen?".
  Bij een duidelijk ja: confirm. Bij nee of iets anders: cancel.
- Na confirm vertel je precies wat confirm teruggeeft: wat gelukt is, met de echte aantallen,
  en wat mislukte. Zeg nooit dat iets staat als confirm dat niet zegt.
- Taken plan je met schedule_task (een vast tijdstip) of plan_range (de planner), nooit als
  afspraak. create_appointment is alleen voor iets met een vaste tijd met iemand of ergens.
- "Haal de planning weg en plan opnieuw tot …" is één plan_range: die vervangt wat de planner
  eerder zette en laat afspraken en handmatige blokken staan. De planner kent de harde
  regels (stage alleen ma-vr binnen de stage-uren); plan zelf nooit stage in het weekend.
- Alles wat je bij een nieuwe afspraak of taak hoort, gaat in de notitie.

--- BRIEF ---
${brief}`

export const MOMENT: Record<'morning' | 'evening', string> = {
  morning:
    '(Ochtendmoment, 08:30. Hidde heeft op de melding getikt. Begin het ochtendgesprek zoals in de brief: haal agenda en taken van vandaag op, noem wat vastligt, wat te laat is en hoe laat hij weg moet, en vraag wat hij vandaag gaat doen.)',
  evening:
    '(Dagafsluiting, 21:00. Hidde heeft op de melding getikt. Doe de dagafsluiting zoals in de brief: day_review van vandaag, zeg wat af is en wat niet — streng —, vraag waarom en wanneer het wel gebeurt, vraag naar extra afspraken, en noem kort wat morgen vastligt.)'
}

interface Live {
  conversation: Conversation
  lastUsed: number
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

  const context = (): string => {
    const now = new Date()
    return `[Nu: ${now.toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, ${now.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}]`
  }

  // ------------------------------------------------------------ the day's opening
  // The first contact of the day opens with the morning conversation. Which day last had
  // one is kept on disk, so a restart of the server does not open the day twice.
  const dayPath = join(dirname(usagePath), 'jarvis-day.json')
  const today = (): string => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  }
  const openedOn = (): string | null => {
    try {
      return existsSync(dayPath) ? ((JSON.parse(readFileSync(dayPath, 'utf8')) as { morning?: string }).morning ?? null) : null
    } catch {
      return null
    }
  }
  const markOpened = (): void => writeFileSync(dayPath, JSON.stringify({ morning: today() }))
  /** Before two in the afternoon; later than that a morning conversation is no use. */
  const openingDue = (): boolean => new Date().getHours() < 14 && openedOn() !== today()

  // --------------------------------------------------------------------- jobs
  // A turn can take half a minute when he replans. On a phone that is long enough for the
  // connection to drop; the job carries on here and the phone asks how it went.
  const jobs = new Map<string, JarvisJob & { at: number }>()

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
        openingDue: openingDue(),
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
        if (Date.now() - live.lastUsed > IDLE_MS) conversations.delete(id)
      }

      let id = input.conversationId ?? null
      let live = id ? conversations.get(id) : undefined
      if (!live || input.moment) {
        id = randomUUID()
        live = { conversation: provider().start(SYSTEM), lastUsed: Date.now() }
        conversations.set(id, live)
      }
      live.lastUsed = Date.now()

      const said = input.moment ? MOMENT[input.moment] : (input.text ?? '').trim()
      if (input.moment === 'morning') markOpened()
      if (!said) throw new Error('Zeg iets tegen Jarvis.')

      const turn = await live.conversation.send(said, context(), (name, args) => runTool(api, name, args), {
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
        if (geminiKey) attempts.push(['audio/wav', () => speakGemini(turn.text, geminiKey, voice, ttsModel)])
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
      if (input.moment === 'morning') markOpened()
      return liveSession({
        api,
        key,
        system: SYSTEM,
        voice,
        opening: input.moment ? MOMENT[input.moment] : null,
        usagePath
      })
    },

    async runTool(input) {
      return runTool(api, input.name, input.args)
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
