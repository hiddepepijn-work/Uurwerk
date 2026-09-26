/**
 * Focus on the laptop: while the timer runs on a focus task (see core/domain/focus.ts),
 * programs on the block list are closed — Steam, Discord and the like, whatever is set
 * under Settings → Focus. Checked every quarter minute, so reopening one does not last.
 *
 * Windows only (tasklist / taskkill); elsewhere this does nothing.
 */

import { execFile } from 'node:child_process'
import { Notification } from 'electron'

import { needsFocus } from '@core/domain/focus.js'
import type { Backend } from '@backend/create.js'
import { log } from './logger.js'

const CHECK_MS = 15_000

let handle: NodeJS.Timeout | null = null

const run = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve) =>
    execFile(file, args, { windowsHide: true }, (error, stdout) => resolve(error ? '' : stdout))
  )

/** Running process names, lower case, without ".exe". */
async function processes(): Promise<Set<string>> {
  const out = await run('tasklist', ['/FO', 'CSV', '/NH'])
  const names = new Set<string>()
  for (const line of out.split(/\r?\n/)) {
    const name = /^"([^"]+)"/.exec(line)?.[1]
    if (name) names.add(name.toLowerCase().replace(/\.exe$/, ''))
  }
  return names
}

export function startFocusGuard(backend: Backend): void {
  stopFocusGuard()
  if (process.platform !== 'win32') return

  const check = async (): Promise<void> => {
    const segment = backend.trackingService.currentSegment()
    const task = segment?.taskId ? backend.store.tasks.get(segment.taskId) : null
    if (!task || task.status === 'done' || !needsFocus(task)) return

    const blocked = backend.store.settings
      .get()
      .focusBlockedApps.map((name) => name.trim().toLowerCase().replace(/\.exe$/, ''))
      .filter(Boolean)
    if (blocked.length === 0) return

    const running = await processes()
    for (const name of blocked) {
      if (!running.has(name)) continue
      await run('taskkill', ['/IM', `${name}.exe`, '/F'])
      log.info('Focus: closed a blocked program.', { name, task: task.title })
      new Notification({ title: `${name} gesloten`, body: `Focus op "${task.title}" tot die af is.` }).show()
    }
  }

  handle = setInterval(() => void check().catch((error: unknown) => log.warn('Focus check failed.', error)), CHECK_MS)
}

export function stopFocusGuard(): void {
  if (handle) clearInterval(handle)
  handle = null
}
