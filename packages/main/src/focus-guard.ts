/**
 * Focus on the laptop: while the timer runs on a focus task (see core/domain/focus.ts),
 * distracting programs are closed. Checked every quarter minute, so reopening one does
 * not last. Two modes, set under Settings → Focus:
 *
 *   - allow: every program with a window that is not on the allow list is asked to close
 *     (like clicking its X); one still running on the next check is killed. Windows' own
 *     processes and this app are never touched — see focus-apps.ts.
 *   - block: programs on the block list are killed outright.
 *
 * The same focus state is served to the Chrome extension by focus-server.ts.
 *
 * Windows only (PowerShell / tasklist / taskkill); elsewhere this does nothing.
 */

import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { Notification } from 'electron'

import { needsFocus } from '@core/domain/focus.js'
import type { Task } from '@core/contract/types.js'
import type { Backend } from '@backend/create.js'
import {
  planAllowListClose,
  parseProcessLines,
  processKey,
  processList,
  siteList,
  type RunningProcess
} from './focus-apps.js'
import { startFocusServer, stopFocusServer } from './focus-server.js'
import { log } from './logger.js'

const CHECK_MS = 15_000

/**
 * One line per process: "pid,windowed,name". Windowed means a main window with a title —
 * background services such as Adobe Desktop Service keep an untitled hidden one. UTF-8 so
 * names outside ASCII survive.
 */
const LIST_PROCESSES =
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' +
  'Get-Process | ForEach-Object { "$($_.Id),$($_.MainWindowHandle -ne 0 -and [bool]$_.MainWindowTitle),$($_.ProcessName)" }'

let handle: NodeJS.Timeout | null = null
/** Allow mode: asked to close on the last check, pid → name. */
let pending = new Map<number, string>()

const run = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve) =>
    execFile(file, args, { windowsHide: true }, (error, stdout) => resolve(error ? '' : stdout))
  )

const powershell = (command: string): Promise<string> =>
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command])

/** The task focus is on right now: the running segment's task, when it needs focus and is not done. */
export function focusTask(backend: Backend): Task | null {
  const segment = backend.trackingService.currentSegment()
  const task = segment?.taskId ? backend.store.tasks.get(segment.taskId) : null
  if (!task || task.status === 'done' || !needsFocus(task)) return null
  return task
}

/** Running process names, lower case, without ".exe". */
async function processNames(): Promise<Set<string>> {
  const out = await run('tasklist', ['/FO', 'CSV', '/NH'])
  const names = new Set<string>()
  for (const line of out.split(/\r?\n/)) {
    const name = /^"([^"]+)"/.exec(line)?.[1]
    if (name) names.add(processKey(name))
  }
  return names
}

function notifyClosed(name: string, task: Task): void {
  new Notification({ title: `${name} gesloten`, body: `Focus op "${task.title}" tot die af is.` }).show()
}

async function blockListCheck(blockedApps: string[], task: Task): Promise<void> {
  const blocked = processList(blockedApps)
  if (blocked.length === 0) return

  const running = await processNames()
  for (const name of blocked) {
    if (!running.has(name)) continue
    await run('taskkill', ['/IM', `${name}.exe`, '/F'])
    log.info('Focus: closed a blocked program.', { name, task: task.title })
    notifyClosed(name, task)
  }
}

async function allowListCheck(allowedApps: string[], task: Task): Promise<void> {
  const running: RunningProcess[] = parseProcessLines(await powershell(LIST_PROCESSES))
  // An empty listing means PowerShell failed, not that nothing runs — do nothing on it.
  if (running.length === 0) return

  const { close, kill } = planAllowListClose({
    running,
    allowed: allowedApps,
    pending,
    // The main process owns the windows; its parent covers a launcher or dev wrapper.
    ownPids: new Set([process.pid, process.ppid]),
    ownNames: new Set([processKey(basename(process.execPath)), 'electron', 'uurwerk'])
  })

  const next = new Map<number, string>()
  for (const proc of kill) {
    await run('taskkill', ['/PID', String(proc.pid), '/F'])
    log.info('Focus: killed a program that did not close.', { name: proc.name, pid: proc.pid, task: task.title })
  }
  for (const proc of close) {
    await powershell(`$p = Get-Process -Id ${proc.pid} -ErrorAction SilentlyContinue; if ($p) { [void]$p.CloseMainWindow() }`)
    next.set(proc.pid, proc.name)
    log.info('Focus: asked a program to close.', { name: proc.name, pid: proc.pid, task: task.title })
    notifyClosed(proc.name, task)
  }
  pending = next
}

export function startFocusGuard(backend: Backend): void {
  stopFocusGuard()
  if (process.platform !== 'win32') return

  startFocusServer(() => {
    const task = focusTask(backend)
    return { focus: task !== null, task: task?.title ?? null, sites: siteList(backend.store.settings.get().focusBlockedSites) }
  })

  const check = async (): Promise<void> => {
    const task = focusTask(backend)
    if (!task) {
      pending = new Map()
      return
    }
    const settings = backend.store.settings.get()
    if (settings.focusMode === 'block') await blockListCheck(settings.focusBlockedApps, task)
    else await allowListCheck(settings.focusAllowedApps, task)
  }

  handle = setInterval(() => void check().catch((error: unknown) => log.warn('Focus check failed.', error)), CHECK_MS)
}

export function stopFocusGuard(): void {
  if (handle) clearInterval(handle)
  handle = null
  pending = new Map()
  stopFocusServer()
}
