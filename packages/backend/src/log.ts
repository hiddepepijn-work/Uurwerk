/**
 * File logging. The app spends most of its life in the tray with no window open, so
 * "what happened at 16:40" has to be answerable after the fact.
 *
 * The file is set by whoever starts the backend: the laptop writes next to its database,
 * the server into its data directory. Until one is set the console is the only output,
 * which is all a test needs.
 */

import { appendFileSync, statSync, renameSync, existsSync } from 'node:fs'

let logPath: (() => string) | null = null

/** Lazy, because on the laptop the path is only known once Electron can answer it. */
export function setLogFile(path: () => string): void {
  logPath = path
}

const MAX_BYTES = 2 * 1024 * 1024

type Level = 'info' | 'warn' | 'error'

function rotateIfNeeded(file: string): void {
  try {
    if (existsSync(file) && statSync(file).size > MAX_BYTES) {
      renameSync(file, `${file}.1`)
    }
  } catch {
    // Logging must never take the app down.
  }
}

function write(level: Level, message: string, detail?: unknown): void {
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}${
    detail === undefined ? '' : ` :: ${safeStringify(detail)}`
  }\n`

  // Keep the dev console useful too.
  if (level === 'error') console.error(line.trim())
  else if (level === 'warn') console.warn(line.trim())
  else console.log(line.trim())

  if (!logPath) return
  try {
    const file = logPath()
    rotateIfNeeded(file)
    appendFileSync(file, line, 'utf8')
  } catch {
    // Ignore — see above.
  }
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export const log = {
  info: (message: string, detail?: unknown) => write('info', message, detail),
  warn: (message: string, detail?: unknown) => write('warn', message, detail),
  error: (message: string, detail?: unknown) => write('error', message, detail)
}
