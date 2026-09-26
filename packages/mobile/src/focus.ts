/**
 * Focus on the phone: while a focus task is on, only the bank, WhatsApp and the built-in
 * apps — until that task is done.
 *
 * iOS gives an app no switch for Focus (short of Screen Time, which needs a paid account and
 * Apple's approval), so the switch is two Shortcuts Hidde makes once, "Uurwerk Focus Aan"
 * and "Uurwerk Focus Uit", each setting the "Uurwerk" Focus. The app runs them through
 * x-callback-url, and Shortcuts sends it straight back.
 *
 *   timer on a focus task   → on, held until that task is ticked off (stopping is not done)
 *   widget Focus button     → on by hand when off; off again when it was on by hand;
 *                             refused while a task holds it
 */

import { Preferences } from '@capacitor/preferences'

import type { Backend } from '@backend/create.js'
import { needsFocus } from '@core/domain/focus.js'

const KEY = 'focusTaskId'
/** Stored instead of a task id when focus was switched on by hand. */
const MANUAL = 'manual'
const ON = 'Uurwerk Focus Aan'
const OFF = 'Uurwerk Focus Uit'

function runShortcut(name: string): void {
  const url =
    `shortcuts://x-callback-url/run-shortcut?name=${encodeURIComponent(name)}` +
    `&x-success=${encodeURIComponent('uurwerk://today')}&x-error=${encodeURIComponent('uurwerk://today')}`
  window.open(url, '_system')
}

export class FocusGuard {
  private current: string | null = null

  constructor(
    private readonly backend: Backend,
    private readonly notify: (message: string) => void,
    /** Called whenever focus goes on or off, so the widget can show it. */
    private readonly changed: () => void
  ) {}

  async load(): Promise<void> {
    this.current = (await Preferences.get({ key: KEY })).value
  }

  private get enabled(): boolean {
    return this.backend.store.settings.get().focusShortcuts
  }

  /** For the widget: the task focus is held for, "Handmatig", or null. */
  label(): string | null {
    if (!this.current) return null
    if (this.current === MANUAL) return 'Handmatig'
    return this.backend.store.tasks.get(this.current)?.title ?? 'Taak'
  }

  private async set(value: string | null): Promise<void> {
    this.current = value
    if (value) await Preferences.set({ key: KEY, value })
    else await Preferences.remove({ key: KEY })
    this.changed()
  }

  /** The timer moved to a task: if it needs focus and none is on, turn it on. */
  async onTaskStarted(taskId: string | null): Promise<void> {
    if (!this.enabled || !taskId || this.current) return
    const task = this.backend.store.tasks.get(taskId)
    if (!task || !needsFocus(task)) return
    await this.set(taskId)
    this.notify(`Focus aan tot "${task.title}" af is.`)
    runShortcut(ON)
  }

  /** Something changed: if the focus task is finished (or gone), release the phone. */
  async check(): Promise<void> {
    if (!this.current || this.current === MANUAL) return
    const task = this.backend.store.tasks.get(this.current)
    if (task && task.status !== 'done') return
    await this.set(null)
    if (!this.enabled) return
    this.notify(task ? `"${task.title}" is af. Focus uit.` : 'Focus uit.')
    runShortcut(OFF)
  }

  /** The widget's Focus button. */
  async toggle(): Promise<void> {
    if (!this.enabled) {
      this.notify('Zet eerst Focus aan onder Settings → Focus (met de twee opdrachten).')
      return
    }
    if (!this.current) {
      await this.set(MANUAL)
      this.notify('Focus aan. Tik nog eens op Focus om hem uit te zetten.')
      runShortcut(ON)
      return
    }
    if (this.current === MANUAL) {
      await this.set(null)
      this.notify('Focus uit.')
      runShortcut(OFF)
      return
    }
    // Held for a task: strict, as agreed — it ends when the task is done, not before.
    this.notify(`Focus blijft aan tot "${this.label()}" af is.`)
  }
}
