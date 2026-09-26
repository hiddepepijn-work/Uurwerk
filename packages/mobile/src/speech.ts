/**
 * The app saying something out loud once you have tapped a question: what today holds, or
 * a nudge for the evening. The notification sound is a fixed clip; this is the part that
 * can mention today's actual appointments and tasks.
 */

import { registerPlugin } from '@capacitor/core'

import type { TimeTrackerAPI } from '@core/contract/api.js'

/**
 * Native, in packages/capacitor-audio-focus: pauses Spotify or Apple Music while the app
 * speaks, and lets it resume afterwards. In a browser there is nothing to pause.
 */
export const AudioFocus = registerPlugin<{
  take(): Promise<void>
  release(): Promise<void>
  setWidgetData(options: { json: string }): Promise<void>
}>('AudioFocus', {
  web: { take: async () => undefined, release: async () => undefined, setWidgetData: async () => undefined }
})

async function say(text: string): Promise<void> {
  if (!('speechSynthesis' in window)) return
  await AudioFocus.take().catch(() => undefined)
  const utterance = new SpeechSynthesisUtterance(text)
  // Hand the audio back however the speech ends, or the music would stay paused.
  const release = (): void => void AudioFocus.release().catch(() => undefined)
  utterance.onend = release
  utterance.onerror = release
  utterance.lang = 'nl-NL'
  const dutch = window.speechSynthesis.getVoices().find((voice) => voice.lang.startsWith('nl'))
  if (dutch) utterance.voice = dutch
  window.speechSynthesis.cancel()
  window.speechSynthesis.speak(utterance)
}

const count = (n: number, one: string, many: string): string => `${n === 0 ? 'geen' : n} ${n === 1 ? one : many}`

export async function speakMorning(api: TimeTrackerAPI): Promise<void> {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)

  const [events, tasks] = await Promise.all([
    api.calendar.eventsInRange(start.getTime(), end.getTime()),
    api.tasks.list({ status: 'active' })
  ])
  const appointments = events.filter((event) => event.kind !== 'travel')
  const first = appointments.sort((a, b) => a.startsAt - b.startsAt)[0]
  const urgent = tasks.filter((task) => task.priority === 'high')

  const parts = [
    `Goedemorgen Hidde. Je hebt vandaag ${count(appointments.length, 'afspraak', 'afspraken')}`,
    first
      ? `, de eerste om ${new Date(first.startsAt).toLocaleTimeString('nl-NL', { hour: 'numeric', minute: '2-digit' })}: ${first.title}.`
      : '.',
    ` Er ${urgent.length === 1 ? 'staat' : 'staan'} ${count(urgent.length, 'taak', 'taken')} met hoge prioriteit open.`,
    ' Wat wil je vandaag doen?'
  ]
  await say(parts.join(''))
}

const AREA_NAMES: Record<string, string> = { stage: 'stage', work: 'werk', school: 'school', personal: 'privé' }

const hours = (minutes: number): string => {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h === 0 ? `${m} minuten` : m === 0 ? `${h} uur` : `${h} uur ${m}`
}

/**
 * The evening review, read out: what got done of today's plan and what did not (said
 * plainly — not done is not done), where the hours went, and the agenda question.
 */
export async function speakEvening(api: TimeTrackerAPI): Promise<void> {
  const now = new Date()
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

  const [plan, open, breakdown] = await Promise.all([
    api.plans.day(date),
    api.tasks.list({ status: 'active' }),
    api.breakdown.day(date)
  ])

  const openIds = new Set(open.map((task) => task.id))
  const planned = new Map<string, string>()
  for (const block of plan.blocks) {
    if (block.kind === 'task' && block.taskId) planned.set(block.taskId, block.taskTitle ?? 'een taak')
  }
  const notDone = [...planned].filter(([id]) => openIds.has(id)).map(([, title]) => title)
  const done = planned.size - notDone.length

  const parts: string[] = ['Hé Hidde, dagafsluiting.']
  if (planned.size === 0) parts.push('Er stond vandaag niets gepland.')
  else if (notDone.length === 0) parts.push(`Alle ${planned.size} geplande taken zijn af. Goed zo.`)
  else {
    parts.push(`${done} van de ${planned.size} geplande taken zijn af.`)
    parts.push(`Niet gedaan: ${notDone.slice(0, 3).join(', ')}. Dat is niet goed. Zet meteen neer wanneer het wel gebeurt.`)
  }

  const worked = Object.entries(breakdown.byArea)
    .filter(([, minutes]) => minutes >= 5)
    .sort((a, b) => b[1] - a[1])
    .map(([area, minutes]) => `${hours(minutes)} ${AREA_NAMES[area] ?? 'zonder gebied'}`)
  parts.push(worked.length > 0 ? `Gewerkt: ${worked.join(', ')}.` : 'Er zijn vandaag geen uren bijgehouden.')
  parts.push('Verdeel je uren, en zijn er nog afspraken die in de agenda moeten?')

  await say(parts.join(' '))
}
