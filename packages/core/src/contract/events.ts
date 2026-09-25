/**
 * Push events, backend -> frontend. One-way, fire and forget.
 *
 * Anything the frontend can ask for lives in TimeTrackerAPI. This file is only for things
 * the backend learns on its own: the clock advancing, a hotkey firing, a screenshot landing.
 */

import type { SkipReason } from '../services/capture.js'
import type { Artifact, Session, TimeSegment } from './types.js'

export interface AppEvents {
  /** Every second while a session runs. Cheap — carries elapsed minutes, not the whole session. */
  'timer:tick': { sessionId: string; elapsedSec: number }
  /** Start, stop, idle-pause, or a manual edit changed the running session. */
  'timer:changed': { session: Session | null; reason: 'start' | 'stop' | 'idle' | 'edit' }
  /** The richer form of the same news: which segment is open, and why it changed. */
  'tracking:segmentChanged': {
    segment: TimeSegment | null
    reason: 'start' | 'stop' | 'switch' | 'complete' | 'idle' | 'edit'
  }
  /** A screenshot was taken (or skipped, with a reason). */
  'capture:taken': { artifact: Artifact }
  'capture:skipped': { reason: SkipReason; matched?: string }
  /** Encoding a day into a timelapse, which takes seconds rather than milliseconds. */
  'timelapse:progress': { date: string; done: number; total: number }
  /** Data changed behind the frontend's back — refetch the named domain. */
  'data:invalidated': { domain: 'tasks' | 'sessions' | 'planning' | 'artifacts' | 'reports' | 'settings' }
  /** The weekly report job ran. */
  'report:generated': { week: string; docxPath: string }
  /** Something the user should see, surfaced as a toast. */
  'notify': { level: 'info' | 'warn' | 'error'; message: string }
  /**
   * A global hotkey or a tray menu item asked the window to open something.
   *
   * The main process owns the hotkeys but must not know how the UI is laid out, so it
   * names the destination and the renderer decides what that means.
   */
  'ui:open': { target: 'switcher' | 'endOfDay' | 'today' | 'tasks' | 'planDay' | 'addEvent' }
}

export type AppEventName = keyof AppEvents

export type AppEventPayload<K extends AppEventName> = AppEvents[K]

/** Subscription surface exposed on window.api alongside TimeTrackerAPI. */
export interface AppEventBus {
  on<K extends AppEventName>(event: K, handler: (payload: AppEvents[K]) => void): () => void
}
