/**
 * Focus on the phone: while a focus task is on, only the bank, WhatsApp and the built-in
 * apps — until that task is done.
 *
 * iOS gives an app no switch for Focus (short of Screen Time, which needs a paid account and
 * Apple's approval), so the switch is two Shortcuts Hidde makes once, "Uurwerk Focus Aan"
 * and "Uurwerk Focus Uit", each setting the "Uurwerk" Focus. The app runs them through
 * x-callback-url, and Shortcuts sends it straight back.
 *
 * Starting the timer on a focus task turns it on. Only finishing that task turns it off:
 * stopping the timer is not finishing.
 */

import { Preferences } from '@capacitor/preferences'

import type { Backend } from '@backend/create.js'
import { needsFocus } from '@core/domain/focus.js'

const KEY = 'focusTaskId'
const ON = 'Uurwerk Focus Aan'
const OFF = 'Uurwerk Focus Uit'

function runShortcut(name: string): void {
  const url =
    `shortcuts://x-callback-url/run-shortcut?name=${encodeURIComponent(name)}` +
    `&x-success=${encodeURIComponent('uurwerk://today')}&x-error=${encodeURIComponent('uurwerk://today')}`
  window.open(url, '_system')
}

export class FocusGuard {
  constructor(
    private readonly backend: Backend,
    private readonly notify: (message: string) => void
  ) {}

  private get enabled(): boolean {
    return this.backend.store.settings.get().focusShortcuts
  }

  /** The timer moved to a task: if it needs focus and none is on, turn it on. */
  async onTaskStarted(taskId: string | null): Promise<void> {
    if (!this.enabled || !taskId) return
    const task = this.backend.store.tasks.get(taskId)
    if (!task || !needsFocus(task)) return
    const current = (await Preferences.get({ key: KEY })).value
    if (current) return
    await Preferences.set({ key: KEY, value: taskId })
    this.notify(`Focus aan tot "${task.title}" af is.`)
    runShortcut(ON)
  }

  /** Something changed: if the focus task is finished (or gone), release the phone. */
  async check(): Promise<void> {
    const current = (await Preferences.get({ key: KEY })).value
    if (!current) return
    const task = this.backend.store.tasks.get(current)
    if (task && task.status !== 'done') return
    await Preferences.remove({ key: KEY })
    if (!this.enabled) return
    this.notify(task ? `"${task.title}" is af. Focus uit.` : 'Focus uit.')
    runShortcut(OFF)
  }
}
