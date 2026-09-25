/**
 * Frames of a day → one .webm, without ffmpeg.
 *
 * The encoding itself happens in a hidden BrowserWindow, because MediaRecorder only exists
 * in a renderer. This file owns everything around it: choosing which frames qualify, feeding
 * them across one at a time, writing the result, and making sure the window is destroyed
 * whether the job succeeded, failed or hung.
 *
 * Only approved frames go in. That is the same rule the .docx follows, and having one rule
 * instead of two is the point: if you did not tick it in the end-of-day wizard, it is not in
 * anything that can leave this machine.
 */

import { BrowserWindow, ipcMain, nativeImage } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Artifact, IsoDate } from '@core/contract/types.js'

import { emitEvent } from './events.js'
// Type-only, so this does not become a runtime cycle with ipc.ts.
import type { Backend } from '@backend/create.js'
import { log } from './logger.js'
import { timelapseDir } from './paths.js'
import { createEncoderWindow } from './windows.js'

/** Two frames is the shortest thing that is honestly a timelapse rather than a photo. */
const MIN_FRAMES = 2
/** A full day at 5-minute intervals is ~100 frames; at 8 fps that records in ~13 seconds. */
const JOB_TIMEOUT_MS = 10 * 60 * 1000

interface Job {
  date: IsoDate
  frames: Artifact[]
  width: number
  height: number
  fps: number
  resolve: (artifact: Artifact | null) => void
  reject: (error: Error) => void
  window: BrowserWindow
  timeout: NodeJS.Timeout
  finished: boolean
}

/** One at a time. Two encoder windows would fight over the same wall clock and both drift. */
let active: Job | null = null
let handlersRegistered = false

export async function buildTimelapse(
  backend: Backend,
  date: IsoDate
): Promise<Artifact | null> {
  if (active) throw new Error('A timelapse is already being built. Wait for it to finish.')

  const frames = backend.store.artifacts
    .listByDay(date, 'screenshot')
    .filter((artifact) => artifact.included)

  if (frames.length < MIN_FRAMES) {
    throw new Error(
      `Only ${frames.length} approved screenshot(s) for ${date}. Approve at least ${MIN_FRAMES} in the screenshot step first — a timelapse is built from approved frames only.`
    )
  }

  const { width, height } = frameSize(frames)
  const fps = clampFps(backend.store.settings.get().timelapseFps)

  registerHandlers(backend)

  return new Promise<Artifact | null>((resolve, reject) => {
    const window = createEncoderWindow()

    active = {
      date,
      frames,
      width,
      height,
      fps,
      resolve,
      reject,
      window,
      finished: false,
      timeout: setTimeout(() => {
        failActive(new Error('The timelapse encoder did not finish in time and was stopped.'))
      }, JOB_TIMEOUT_MS)
    }

    // A renderer crash must not leave the caller waiting forever on a promise.
    window.webContents.on('render-process-gone', (_event, details) => {
      failActive(new Error(`The timelapse encoder stopped unexpectedly (${details.reason}).`))
    })

    log.info('Timelapse encoding started.', { date, frames: frames.length, width, height, fps })
  })
}

// ------------------------------------------------------------------- handlers

/**
 * Registered once, for the lifetime of the app.
 *
 * Every handler checks that the sender is the window of the job currently running. Without
 * that check a page that somehow got this preload could pull frames from a job it did not
 * start; with it, a message from anything but the live encoder window is dropped.
 */
function registerHandlers(backend: Backend): void {
  if (handlersRegistered) return
  handlersRegistered = true

  const jobFor = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): Job | null =>
    active && !active.window.isDestroyed() && event.sender.id === active.window.webContents.id
      ? active
      : null

  ipcMain.handle('timelapse:ready', (event) => {
    const job = jobFor(event)
    if (!job) throw new Error('No timelapse job is running.')
    return { total: job.frames.length, width: job.width, height: job.height, fps: job.fps, date: job.date }
  })

  ipcMain.handle('timelapse:frame', (event, index: unknown) => {
    const job = jobFor(event)
    if (!job) throw new Error('No timelapse job is running.')
    if (typeof index !== 'number' || !Number.isInteger(index)) return null

    const artifact = job.frames[index]
    if (!artifact) return null

    try {
      // Base64 rather than a file:// URL: the encoder page has no filesystem access by
      // design, and in dev it is served over http where file: subresources are blocked.
      return `data:image/jpeg;base64,${readFileSync(artifact.path).toString('base64')}`
    } catch (error) {
      log.warn('A frame could not be read and was skipped.', { path: artifact.path, error })
      return null
    }
  })

  ipcMain.on('timelapse:progress', (event, done: unknown) => {
    const job = jobFor(event)
    if (!job || typeof done !== 'number') return
    emitEvent('timelapse:progress', { date: job.date, done, total: job.frames.length })
  })

  ipcMain.handle('timelapse:finish', (event, bytes: unknown) => {
    const job = jobFor(event)
    if (!job) throw new Error('No timelapse job is running.')

    const buffer = toBuffer(bytes)
    if (!buffer || buffer.length === 0) {
      failActive(new Error('The encoder produced an empty video.'))
      return
    }

    const path = join(timelapseDir(), `${job.date}.webm`)
    writeFileSync(path, buffer)

    // Replacing a previous run for the same day rather than stacking copies: rebuilding
    // after approving more frames is the normal case, not the exception.
    for (const previous of backend.store.artifacts.listByDay(job.date, 'timelapse')) {
      backend.store.artifacts.remove(previous.id)
    }

    const artifact = backend.store.artifacts.add({
      day: job.date,
      kind: 'timelapse',
      path,
      // Built entirely from frames you already approved, so it inherits that approval.
      // It still needs the day's timelapse flag and a Publish press to go anywhere.
      included: true
    })

    log.info('Timelapse written.', { path, bytes: buffer.length })
    finishActive(artifact)
  })

  ipcMain.handle('timelapse:fail', (event, message: unknown) => {
    if (!jobFor(event)) return
    failActive(new Error(typeof message === 'string' ? message : 'The encoder failed.'))
  })
}

// ------------------------------------------------------------------- lifecycle

function finishActive(artifact: Artifact | null): void {
  const job = active
  if (!job || job.finished) return
  job.finished = true

  clearTimeout(job.timeout)
  if (!job.window.isDestroyed()) job.window.destroy()
  active = null

  emitEvent('data:invalidated', { domain: 'artifacts' })
  job.resolve(artifact)
}

function failActive(error: Error): void {
  const job = active
  if (!job || job.finished) return
  job.finished = true

  clearTimeout(job.timeout)
  if (!job.window.isDestroyed()) job.window.destroy()
  active = null

  log.error('Timelapse encoding failed.', error)
  job.reject(error)
}

/** Called on quit so a half-finished job cannot hold the app open. */
export function cancelTimelapse(): void {
  if (active) failActive(new Error('Uurwerk is closing.'))
}

// --------------------------------------------------------------------- helpers

/**
 * The output size, taken from the first frame that can be read.
 *
 * Every frame of a day is normally the same monitor at the same scale, so the first one is
 * representative; anything that is not gets letterboxed by the encoder rather than stretched.
 * Both dimensions are forced even because VP8 and VP9 encode in 2×2 blocks and an odd size
 * is silently rounded — better to choose the rounding here than to be surprised by it.
 */
function frameSize(frames: Artifact[]): { width: number; height: number } {
  for (const artifact of frames) {
    const image = nativeImage.createFromPath(artifact.path)
    if (image.isEmpty()) continue
    const size = image.getSize()
    if (size.width > 0 && size.height > 0) {
      return { width: even(size.width), height: even(size.height) }
    }
  }
  return { width: 1280, height: 720 }
}

const even = (value: number): number => (value % 2 === 0 ? value : value - 1)

/** 1–30. Below 1 the video never advances; above 30 a working day flashes past unreadably. */
const clampFps = (fps: number): number =>
  Number.isFinite(fps) ? Math.min(30, Math.max(1, Math.round(fps))) : 8

/** The renderer sends a Uint8Array; structured cloning may hand it over as an ArrayBuffer. */
function toBuffer(value: unknown): Buffer | null {
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value))
  return null
}
