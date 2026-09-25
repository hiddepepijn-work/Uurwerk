/**
 * The app saying something out loud once you have tapped a question: what today holds, or
 * a nudge for the evening. The notification sound is a fixed clip; this is the part that
 * can mention today's actual appointments and tasks.
 */

import type { TimeTrackerAPI } from '@core/contract/api.js'

function say(text: string): void {
  if (!('speechSynthesis' in window)) return
  const utterance = new SpeechSynthesisUtterance(text)
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
  say(parts.join(''))
}

export function speakEvening(): void {
  say('Hé Hidde. Zijn er nog afspraken die in de agenda moeten? Zet ze er meteen in.')
}
