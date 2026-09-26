import type { Settings } from '../../contract/types.js'
import { Db } from '../connection.js'

/**
 * Defaults chosen in the plan. Every one of them is adjustable in the Settings screen.
 *
 * Note what is deliberately conservative:
 *   - mailMode 'draft'   -> nothing is ever mailed without you pressing send
 *   - publishEnabled off -> nothing leaves the machine until you turn it on
 *   - captureBlocklist   -> communication apps never end up in a screenshot
 */
export const DEFAULT_SETTINGS: Settings = {
  hotkeys: {
    startStop: 'CommandOrControl+Alt+S',
    quickAdd: 'CommandOrControl+Alt+T',
    toggleWindow: 'CommandOrControl+Alt+D',
    markScreenshot: 'CommandOrControl+Alt+P',
    endOfDay: 'CommandOrControl+Alt+E'
  },
  dailyGoalMin: 8 * 60,
  weeklyGoalMin: 40 * 60,
  // This is an internship app; work logged without a stated area is internship work.
  defaultAreaId: 'stage',
  // A minute is fine: roughly 50 MB a day, and frames expire after 14 days, so the cost is
  // a rolling ~700 MB rather than something that grows without end.
  captureIntervalMin: 1,
  captureEnabled: true,
  captureQuality: 'hd',
  idleTimeoutMin: 5,
  // Losing an hour because the timer sat off after a coffee is the more common mistake.
  resumeAfterIdle: true,
  captureBlocklist: [
    'teams',
    'zoom',
    'outlook',
    'whatsapp',
    'signal',
    'bitwarden',
    '1password',
    'keepass',
    'lastpass'
  ],
  // Paired with the one-minute interval: 480 frames a day would be a full minute of video
  // at 8 fps, and encoding runs in real time — so this is 30 seconds instead of 60.
  timelapseFps: 16,
  reportOutputDir: '',
  supervisorEmail: '',
  supervisorName: '',
  mailMode: 'draft',
  smtpHost: '',
  smtpPort: 587,
  smtpUser: '',
  publishEnabled: false,
  publishUrl: '',
  // Ask when unsure: a popup per appointment gets dismissed on reflex, and silent guessing
  // files hours under the wrong project without anyone noticing.
  calendarClassification: 'ask-when-uncertain',
  calendarAskBelow: 80,
  calendarAutoSync: true,
  // Twenty minutes: the publisher regenerates a shared calendar on its own schedule, so
  // asking more often mostly costs battery for the same file.
  calendarSyncEveryMin: 20,
  calendarLearn: true,
  calendarNotifyOnAuto: true,
  autoLaunch: true,
  // Starting at login must not put a window in your face, and must never start a timer.
  startupBehaviour: 'tray',
  showMorningNotification: true,
  closeToTray: true,
  serverUrl: '',
  focusShortcuts: false,
  focusBlockedApps: ['steam', 'discord', 'epicgameslauncher', 'spotify']
}

export class SettingsRepo {
  constructor(private readonly db: Db) {}

  /** Stored values are merged over the defaults, so new settings appear without a migration. */
  get(): Settings {
    const rows = this.db.all<{ key: string; value: string }>('SELECT key, value FROM settings')
    const stored: Record<string, unknown> = {}
    for (const row of rows) {
      try {
        stored[row.key] = JSON.parse(row.value)
      } catch {
        // A corrupt value must never take the app down — fall back to the default.
        continue
      }
    }
    return {
      ...DEFAULT_SETTINGS,
      ...(stored as Partial<Settings>),
      hotkeys: { ...DEFAULT_SETTINGS.hotkeys, ...((stored.hotkeys as object) ?? {}) }
    }
  }

  update(patch: Partial<Settings>): Settings {
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(patch)) {
        this.db.run(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          [key, JSON.stringify(value)]
        )
      }
    })
    return this.get()
  }
}
