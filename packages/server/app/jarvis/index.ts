/**
 * ★ Jarvis. ★
 *
 * The brief in docs/jarvis.md is his standing instruction; the tools are the app's own API;
 * the model and the voice are settings on the server:
 *
 *   JARVIS_MODEL     gemini-3.8-flash | mistral-medium-latest | gpt-6-luna | claude-opus-5 | …
 *                    — the prefix picks the provider and the key it needs
 *   JARVIS_EFFORT    low | medium (default) | high   — how much the model thinks per turn
 *   AZURE_SPEECH_REGION  westeurope (default)
 *   secrets.json     geminiKey / mistralKey / openaiKey / anthropicKey, azureSpeechKey
 *                    (bin/uurwerk-secrets.js). Without an Azure key: the free Edge voice.
 *
 * Conversations live in memory for two hours: long enough for the morning's back-and-forth,
 * short enough that tomorrow starts fresh.
 */

import { randomUUID } from 'node:crypto'

import type { JarvisAsk, JarvisReply, JarvisStatus, TimeTrackerAPI } from '@core/contract/api.js'
import type { SecretVault } from '@backend/host.js'
import { log } from '@backend/log.js'

import brief from '../../../../docs/jarvis.md'
import { claude, compatible, openai, type Conversation, type Provider } from './providers.js'
import { speak, speakFree, speakGemini } from './speech.js'
import { runTool } from './tools.js'

const IDLE_MS = 2 * 3_600_000

const SYSTEM = `Je bent Jarvis, de assistent van Hidde in de app Uurwerk. Hieronder staat je brief: wie
Hidde is, wat je doet op welke momenten, wat je altijd vraagt en wat je wel en niet mag.
Volg die precies.

Regels voor elk antwoord:
- Je antwoord wordt voorgelezen. Schrijf gesproken Nederlands: korte zinnen, geen opmaak,
  geen lijstjes met streepjes, geen emoji. Tijden als "half negen" of "18:25" is allebei goed.
- Maximaal een paar zinnen per beurt. Stel één vraag tegelijk.
- Haal feiten op met je tools (get_now, get_agenda, list_tasks, day_review) voordat je
  iets over de agenda of taken zegt. Verzin nooit een afspraak, taak of tijd.
- Schrijvende tools (aanmaken, wijzigen, plannen, timer): eerst samenvatten wat je gaat
  doen en vragen "Zal ik dat zo doen?". Pas na een duidelijk ja de tool aanroepen met
  confirmed: true. Daarna kort terugzeggen wat er nu staat.
- Alles wat je bij een nieuwe afspraak of taak hoort, gaat in de notitie.

--- BRIEF ---
${brief}`

const MOMENT: Record<'morning' | 'evening', string> = {
  morning:
    '(Ochtendmoment, 08:30. Hidde heeft op de melding getikt. Begin het ochtendgesprek zoals in de brief: haal agenda en taken van vandaag op, noem wat vastligt, wat te laat is en hoe laat hij weg moet, en vraag wat hij vandaag gaat doen.)',
  evening:
    '(Dagafsluiting, 21:00. Hidde heeft op de melding getikt. Doe de dagafsluiting zoals in de brief: day_review van vandaag, zeg wat af is en wat niet — streng —, vraag waarom en wanneer het wel gebeurt, vraag naar extra afspraken, en noem kort wat morgen vastligt.)'
}

interface Live {
  conversation: Conversation
  lastUsed: number
}

export function createJarvis(api: TimeTrackerAPI, secrets: SecretVault): TimeTrackerAPI['jarvis'] {
  const conversations = new Map<string, Live>()
  const model = process.env.JARVIS_MODEL?.trim() || 'claude-opus-5'
  const effort = (process.env.JARVIS_EFFORT as 'low' | 'medium' | 'high' | undefined) ?? 'medium'
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

  return {
    async status(): Promise<JarvisStatus> {
      const keyPresent = secrets.has(keyName)
      return {
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
      if (!said) throw new Error('Zeg iets tegen Jarvis.')

      const turn = await live.conversation.send(said, context(), (name, args) => runTool(api, name, args))

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
    }
  }
}
