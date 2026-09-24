/**
 * Where everything lives on disk.
 *
 * Runtime data never sits in the repo — the database and the frames go to userData, and
 * finished reports go to Documents where you can actually find and attach them.
 */

import { app } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { IsoDate } from '@core/contract/types.js'

const ensure = (dir: string): string => {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** userData/uurwerk — the app's private data root. */
export const dataRoot = (): string => ensure(join(app.getPath('userData'), 'uurwerk'))

export const dbPath = (): string => join(dataRoot(), 'app.db')

export const mediaRoot = (): string => ensure(join(dataRoot(), 'media'))

/** One folder per day keeps the retention job trivial and the folders browsable. */
export const mediaDayDir = (day: IsoDate): string => ensure(join(mediaRoot(), day))

export const timelapseDir = (): string => ensure(join(dataRoot(), 'timelapse'))

export const logPath = (): string => join(dataRoot(), 'uurwerk.log')

/** Documents/Uurwerk-rapporten — deliberately outside userData, so reports are findable. */
export const defaultReportDir = (): string =>
  ensure(join(app.getPath('documents'), 'Uurwerk-rapporten'))

export function reportDir(configured: string): string {
  return configured.trim() ? ensure(configured) : defaultReportDir()
}
