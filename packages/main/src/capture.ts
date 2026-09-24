/**
 * Automatic screen capture.
 *
 * The loop ticks often and captures rarely: every ten seconds it asks the pure policy in
 * core whether a frame is due, and only when the answer is yes does it pay for the
 * foreground-window probe and the encode. On the default one-minute interval that is one
 * screenshot per six ticks.
 *
 * What lands on disk is a downscaled JPEG in userData/uurwerk/media/YYYY-MM-DD/. Nothing is
 * uploaded, nothing is included in a report, and nothing is even readable by the renderer
 * until it is approved frame by frame in the end-of-day wizard.
 *
 * One limitation worth stating plainly rather than burying: the blocklist checks the window
 * that has *focus*. A screenshot is of the whole primary screen, so a blocked application
 * sitting in a side window is still in the frame. The blocklist stops the app from recording
 * you while you are working in Teams; it cannot stop Teams from being visible behind
 * something else. That is what the per-frame approval gate is for.
 */

import { desktopCapturer, powerMonitor, screen } from 'electron'
import { randomBytes } from 'node:crypto'
import { unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Artifact } from '@core/contract/types.js'
import { captureProfile, explainSkip, shouldAttempt, windowAllows } from '@core/services/capture.js'
import { RetentionService } from '@core/services/retention.js'
import { toIsoDate } from '@core/util/time.js'

import { foregroundWindowTitle } from './blocklist.js'
import { emitEvent } from './events.js'
// Type-only, so this does not become a runtime cycle with ipc.ts.
import type { Backend } from './ipc.js'
import { log } from './logger.js'
import { mediaDayDir } from './paths.js'

/**
 * Ten seconds, not thirty.
 *
 * The interval can be as short as a minute, and a thirty-second tick would turn that into
 * anything between sixty and ninety seconds depending on where the tick happened to land.
 * A tick this cheap — one settings read, no process spawn unless a frame is actually due —
 * can afford to be frequent enough that the setting means what it says.
 */
const TICK_MS = 10_000
/** Once every six hours is plenty for a 14-day retention window. */
const RETENTION_SWEEP_MS = 6 * 60 * 60 * 1000

let backend: Backend | null = null
let tickHandle: NodeJS.Timeout | null = null
let sweepHandle: NodeJS.Timeout | null = null

/** Null means "no frame taken yet this run", which makes the first frame immediate. */
let lastCaptureAt: number | null = null
/** The probe spawns a process; overlapping ticks must not spawn two. */
let inFlight = false

// ------------------------------------------------------------------- the loop

export function startCapture(instance: Backend): void {
  backend = instance

  // A fresh segment deserves its own frame straight away — the first screenshot of a task
  // is the one that shows what the task actually was.
  backend.trackingService.onChange((segment) => {
    if (segment) lastCaptureAt = null
  })

  tickHandle = setInterval(() => void tick(), TICK_MS)
  sweepHandle = setInterval(() => sweepExpired(), RETENTION_SWEEP_MS)

  // Old frames from a previous run should not survive a restart either.
  sweepExpired()
  log.info('Capture loop started.')
}

export function stopCapture(): void {
  if (tickHandle) clearInterval(tickHandle)
  if (sweepHandle) clearInterval(sweepHandle)
  tickHandle = null
  sweepHandle = null
}

async function tick(): Promise<void> {
  if (!backend || inFlight) return

  const settings = backend.store.settings.get()
  const timing = shouldAttempt({
    enabled: settings.captureEnabled,
    tracking: backend.trackingService.isRunning(),
    intervalMin: settings.captureIntervalMin,
    lastCaptureAt,
    now: Date.now(),
    idleSec: powerMonitor.getSystemIdleTime(),
    idleTimeoutMin: settings.idleTimeoutMin
  })

  // The common case: nothing is due. Costs one settings read and no process spawn.
  if (!timing.capture) return

  inFlight = true
  try {
    const allowed = windowAllows(await foregroundWindowTitle(), settings.captureBlocklist)
    if (!allowed.capture) {
      // Push the clock forward anyway. Without this a blocked window would be re-probed on
      // every tick for as long as it stays in front, spawning a process each time.
      lastCaptureAt = Date.now()
      emitEvent('capture:skipped', {
        reason: allowed.reason!,
        ...(allowed.matched === undefined ? {} : { matched: allowed.matched })
      })
      return
    }

    const artifact = await grabFrame({ included: false })
    if (artifact) {
      lastCaptureAt = artifact.capturedAt
      emitEvent('capture:taken', { artifact })
      emitEvent('data:invalidated', { domain: 'artifacts' })
    }
  } catch (error) {
    log.error('A screenshot failed; capture continues.', error)
    lastCaptureAt = Date.now()
  } finally {
    inFlight = false
  }
}

// -------------------------------------------------------------- manual capture

/**
 * The Ctrl+Alt+P grab.
 *
 * Deliberate, so it ignores the interval, the idle timer and the enabled switch — but not
 * the blocklist. If a window is on the never-capture list, pressing a key is not the way to
 * override that; removing it from the list in Settings is. Returns null with a toast when
 * it refuses, rather than pretending to have taken something.
 */
export async function captureNow(): Promise<Artifact | null> {
  if (!backend) return null

  const settings = backend.store.settings.get()
  const allowed = windowAllows(await foregroundWindowTitle(), settings.captureBlocklist)

  if (!allowed.capture) {
    emitEvent('notify', {
      level: 'warn',
      message: `No screenshot taken. ${explainSkip(allowed.reason!, allowed.matched)}`
    })
    emitEvent('capture:skipped', {
      reason: allowed.reason!,
      ...(allowed.matched === undefined ? {} : { matched: allowed.matched })
    })
    return null
  }

  // Pressing the key is the approval — this frame is marked for the report immediately.
  // It still cannot leave the machine until the day's publish flag is set and you press
  // Publish, so "included" means "eligible", never "sent".
  const artifact = await grabFrame({ included: true })
  if (!artifact) return null

  lastCaptureAt = artifact.capturedAt
  emitEvent('capture:taken', { artifact })
  emitEvent('data:invalidated', { domain: 'artifacts' })
  emitEvent('notify', { level: 'info', message: 'Screenshot saved and marked for the report.' })
  return artifact
}

// -------------------------------------------------------------- the frame itself

async function grabFrame(options: { included: boolean }): Promise<Artifact | null> {
  if (!backend) return null

  const profile = captureProfile(backend.store.settings.get().captureQuality)

  const display = screen.getPrimaryDisplay()
  // Native pixels, not the DIP size: on a 125%-scaled 1920×1080 screen `size` reports
  // 1536×864, and capturing that would quietly throw away a fifth of the resolution.
  const nativeWidth = Math.round(display.size.width * display.scaleFactor)
  const nativeHeight = Math.round(display.size.height * display.scaleFactor)
  // A ceiling, never an enlargement — upscaling adds bytes and no detail.
  const factor = Math.min(1, profile.maxWidth / Math.max(1, nativeWidth))

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(nativeWidth * factor),
      height: Math.round(nativeHeight * factor)
    },
    fetchWindowIcons: false
  })

  // Primary monitor only, as agreed — a second screen doubles the storage and rarely adds
  // anything the first one does not already show.
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
  if (!source || source.thumbnail.isEmpty()) {
    log.warn('The screen capture came back empty; skipping this frame.')
    return null
  }

  const now = Date.now()
  const day = toIsoDate(now)
  const path = join(mediaDayDir(day), frameName(now))
  writeFileSync(path, source.thumbnail.toJPEG(profile.jpegQuality))

  return backend.store.artifacts.add({
    timeSegmentId: backend.trackingService.currentSegment()?.id ?? null,
    day,
    kind: 'screenshot',
    path,
    capturedAt: now,
    included: options.included
  })
}

/** `14-32-05-a1b2.jpg` — sorts chronologically, and two frames in one second cannot collide. */
function frameName(at: number): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const suffix = randomBytes(2).toString('hex')
  return `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}-${suffix}.jpg`
}

// ------------------------------------------------------------------- retention

/**
 * Deletes frames past the retention window, file first and row second.
 *
 * That order matters: a row without a file shows as a broken thumbnail, but a file without
 * a row is invisible and never cleaned up again. Timelapses and reports are kept — they are
 * small and they are what you may need months from now.
 */
export function sweepExpired(): void {
  if (!backend) return

  const retention = new RetentionService(backend.store)
  const expired = retention.expired()
  if (expired.length === 0) return

  const removed: string[] = []
  for (const artifact of expired) {
    try {
      unlinkSync(artifact.path)
    } catch (error) {
      // Already gone, or on a drive that is not there. The row still has to go.
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') log.warn('Could not delete an expired frame.', { path: artifact.path, code })
    }
    removed.push(artifact.id)
  }

  retention.forget(removed)
  log.info(`Retention: removed ${removed.length} screenshot(s) older than 14 days.`)
  emitEvent('data:invalidated', { domain: 'artifacts' })
}
