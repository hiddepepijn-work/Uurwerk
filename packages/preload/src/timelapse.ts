/**
 * The encoder window's bridge — deliberately not the app's bridge.
 *
 * The timelapse page needs to pull frames and push back a finished video, which is nothing
 * the rest of the frontend may do. Rather than widen `window.api` with five channels that
 * exist for one hidden window, that window gets its own preload exposing exactly those five
 * and nothing else. The main bridge stays as small as it was.
 *
 * Note what is still not here: no file paths, no fs, no ipcRenderer. Frames arrive as data
 * URLs that the main process chose to hand over; the page cannot ask for an arbitrary file.
 */

import { contextBridge, ipcRenderer } from 'electron'

export interface TimelapseJob {
  total: number
  width: number
  height: number
  fps: number
  date: string
}

contextBridge.exposeInMainWorld('encoder', {
  /** Blocks until the main process has a job ready; resolves with its shape. */
  ready: (): Promise<TimelapseJob> => ipcRenderer.invoke('timelapse:ready'),
  /** One frame, as a data: URL. Out-of-range indexes come back null. */
  frame: (index: number): Promise<string | null> => ipcRenderer.invoke('timelapse:frame', index),
  progress: (done: number): void => {
    ipcRenderer.send('timelapse:progress', done)
  },
  finish: (bytes: Uint8Array): Promise<void> => ipcRenderer.invoke('timelapse:finish', bytes),
  fail: (message: string): Promise<void> => ipcRenderer.invoke('timelapse:fail', message)
})
