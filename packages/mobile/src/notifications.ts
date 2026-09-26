/**
 * The two daily questions, as local notifications with a spoken sound.
 *
 *   08:30  "Hoi Hidde! Goedemorgen. Hoe ziet je ochtend eruit?"  → opens the day planner
 *   21:00  "Hé Hidde. Zijn er nog afspraken die in de agenda moeten?" → opens a new event
 *
 * iOS lets any notification be swiped away, so the morning one comes back: 08:35, 08:40 and
 * 08:45 are scheduled too, and tapping any of them cancels the rest of that day's series.
 * Everything is scheduled on the phone itself, a week ahead and topped up at every start —
 * no server and no push, which is what makes it work without a paid Apple account.
 */

import { Directory, Filesystem } from '@capacitor/filesystem'
import { LocalNotifications, type LocalNotificationSchema } from '@capacitor/local-notifications'
import { Preferences } from '@capacitor/preferences'

import { toBase64 } from './database.js'

type Target = 'planDay' | 'addEvent'

interface Moment {
  key: 'morning' | 'evening'
  hour: number
  /** First is the question; the rest repeat it until one of them is tapped. */
  minutes: number[]
  sound: string
  title: string
  body: string
  target: Target
}

const MOMENTS: Moment[] = [
  {
    key: 'morning',
    hour: 8,
    minutes: [30, 35, 40, 45],
    sound: 'ochtend.caf',
    title: 'Goedemorgen Hidde',
    body: 'Hoe ziet je ochtend eruit? Tik om je dag te plannen.',
    target: 'planDay'
  },
  {
    key: 'evening',
    hour: 21,
    minutes: [0, 10],
    sound: 'avond.caf',
    title: 'Nog iets voor de agenda?',
    body: 'Zijn er afspraken die je moet toevoegen? Tik om er een te maken.',
    target: 'addEvent'
  }
]

const DAYS_AHEAD = 7

/** yyyymmdd * 100 + moment * 10 + repeat — stable, so rescheduling replaces rather than stacks. */
const idFor = (date: Date, moment: number, repeat: number): number =>
  Number(
    `${date.getFullYear() % 100}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
  ) *
    100 +
  moment * 10 +
  repeat

const dayKey = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

/**
 * Notification sounds must be in the app bundle or in Library/Sounds. The bundle's web
 * folder is neither, so the clips are copied across once.
 */
async function installSounds(): Promise<void> {
  for (const moment of MOMENTS) {
    try {
      await Filesystem.stat({ path: `Sounds/${moment.sound}`, directory: Directory.Library })
      continue
    } catch {
      // Not there yet.
    }
    try {
      const response = await fetch(`/sounds/${moment.sound}`)
      if (!response.ok) continue
      const bytes = new Uint8Array(await response.arrayBuffer())
      await Filesystem.writeFile({
        path: `Sounds/${moment.sound}`,
        directory: Directory.Library,
        data: toBase64(bytes),
        recursive: true
      })
    } catch {
      // Without the clip the notification still arrives, with the default sound.
    }
  }
}

/** Asks once, then schedules the coming week. Safe to call at every start. */
export async function scheduleDailyQuestions(): Promise<void> {
  const permission = await LocalNotifications.requestPermissions()
  if (permission.display !== 'granted') return
  await installSounds()

  const pending = await LocalNotifications.getPending()
  if (pending.notifications.length > 0) {
    await LocalNotifications.cancel({ notifications: pending.notifications.map(({ id }) => ({ id })) })
  }

  const now = Date.now()
  const notifications: LocalNotificationSchema[] = []

  for (let offset = 0; offset < DAYS_AHEAD; offset++) {
    const day = new Date()
    day.setDate(day.getDate() + offset)

    for (const [index, moment] of MOMENTS.entries()) {
      // A question already answered today does not come back today.
      if ((await Preferences.get({ key: `answered:${moment.key}:${dayKey(day)}` })).value) continue

      moment.minutes.forEach((minute, repeat) => {
        const at = new Date(day)
        at.setHours(moment.hour, minute, 0, 0)
        if (at.getTime() <= now) return
        notifications.push({
          id: idFor(day, index, repeat),
          title: moment.title,
          body: repeat === 0 ? moment.body : `${moment.body} (${repeat + 1}e keer)`,
          schedule: { at, allowWhileIdle: true },
          sound: moment.sound,
          extra: { target: moment.target, moment: moment.key, day: dayKey(day) }
        })
      })
    }
  }

  // iOS keeps at most 64 pending; a week of both moments is 42.
  if (notifications.length > 0) await LocalNotifications.schedule({ notifications })
}

/**
 * A tap on one of the questions: the rest of that day's series is cancelled, and the app
 * is told where to go.
 */
export function onQuestionTapped(open: (target: Target, moment: 'morning' | 'evening') => void): void {
  void LocalNotifications.addListener('localNotificationActionPerformed', async ({ notification }) => {
    const { target, moment, day } = (notification.extra ?? {}) as {
      target?: Target
      moment?: 'morning' | 'evening'
      day?: string
    }
    if (!target || !moment || !day) return

    await Preferences.set({ key: `answered:${moment}:${day}`, value: '1' })
    const pending = await LocalNotifications.getPending()
    const rest = pending.notifications.filter((entry) => {
      const extra = (entry.extra ?? {}) as { moment?: string; day?: string }
      return extra.moment === moment && extra.day === day
    })
    if (rest.length > 0) await LocalNotifications.cancel({ notifications: rest.map(({ id }) => ({ id })) })

    open(target, moment)
  })
}
