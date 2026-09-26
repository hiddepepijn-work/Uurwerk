/**
 * The two daily questions, as local notifications with a spoken sound.
 *
 *   08:30  "Hoi Hidde! Goedemorgen. Hoe ziet je ochtend eruit?"  → opens the day planner
 *   21:00  "Hé Hidde. Dagafsluiting." → opens the end-of-day review: what got done, where
 *          the hours went, and whether anything has to go in the agenda
 *
 * iOS lets any notification be swiped away, so the morning one comes back: 08:35, 08:40 and
 * 08:45 are scheduled too, and tapping any of them cancels the rest of that day's series.
 * Everything is scheduled on the phone itself, a week ahead and topped up at every start —
 * no server and no push, which is what makes it work without a paid Apple account.
 */

import { Directory, Filesystem } from '@capacitor/filesystem'
import { LocalNotifications, type LocalNotificationSchema } from '@capacitor/local-notifications'
import { Preferences } from '@capacitor/preferences'

import type { Reminder } from '@core/services/reminders.js'

import { toBase64 } from './database.js'

type Target = 'planDay' | 'endOfDay'

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
    title: 'Dagafsluiting',
    body: 'Is alles gelukt? Waar heb je aan gewerkt, en moet er nog iets in de agenda?',
    target: 'endOfDay'
  }
]

// Three days of questions (18) leaves room under iOS's 64 pending for two days of reminders.
const DAYS_AHEAD = 3
const REMINDER_HOURS = 48
const MAX_PENDING = 64

/** Every reminder sound; the questions bring their own. */
const SOUNDS = ['ochtend.caf', 'avond.caf', 'herinnering.caf', 'vertrek.caf']

const REMINDER_SOUND: Record<Reminder['kind'], string | undefined> = {
  task: undefined,
  appointment: undefined,
  gather: 'herinnering.caf',
  // The spoken one: "Hidde, lukt het? Nog een kwartier, dan moet je in de auto zitten."
  leave: 'vertrek.caf'
}

/** A reminder's key as a notification id: stable, positive, clear of the questions' ids. */
const reminderId = (key: string): number => {
  let hash = 7
  for (let index = 0; index < key.length; index++) hash = (hash * 31 + key.charCodeAt(index)) | 0
  return 1_000_000_000 + (Math.abs(hash) % 1_000_000_000)
}

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

let soundsInstalled = false

/**
 * Notification sounds must be in the app bundle or in Library/Sounds. The bundle's web
 * folder is neither, so the clips are copied across.
 */
async function installSounds(): Promise<void> {
  for (const sound of SOUNDS) {
    // Written at every start, not once: a clip that was re-recorded has to replace the
    // copy iOS already has, or the old voice keeps playing.
    try {
      const response = await fetch(`/sounds/${sound}`)
      if (!response.ok) continue
      const bytes = new Uint8Array(await response.arrayBuffer())
      await Filesystem.writeFile({
        path: `Sounds/${sound}`,
        directory: Directory.Library,
        data: toBase64(bytes),
        recursive: true
      })
    } catch {
      // Without the clip the notification still arrives, with the default sound.
    }
  }
}

/**
 * Everything the phone says by itself: the two daily questions and the reminders before
 * tasks and departures. Rebuilt whole each time — at start, on returning to the app and
 * after the plan changes — so a moved block never leaves its old reminder behind.
 */
export async function scheduleNotifications(
  reminders: (fromMs: number, toMs: number) => Reminder[]
): Promise<void> {
  const permission = await LocalNotifications.requestPermissions()
  if (permission.display !== 'granted') return
  if (!soundsInstalled) {
    await installSounds()
    soundsInstalled = true
  }

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

  for (const reminder of reminders(now, now + REMINDER_HOURS * 3_600_000)) {
    if (notifications.length >= MAX_PENDING) break
    notifications.push({
      id: reminderId(reminder.key),
      title: reminder.title,
      body: reminder.body,
      schedule: { at: new Date(reminder.at), allowWhileIdle: true },
      sound: REMINDER_SOUND[reminder.kind],
      extra: { reminder: reminder.kind }
    })
  }

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
