/**
 * TimerService — a façade over TrackingService.
 *
 * The tracking model changed from "one session, one task" to "one run, many segments".
 * Rather than rewriting every caller at once, this keeps the old surface working and
 * translates it: a `Session` is simply the currently open `TimeSegment` in the shape the
 * older code expects.
 *
 * The façade exists to make one risky change safe, not to live forever. New code should
 * use TrackingService directly — it is the only one that can express switching tasks.
 */

import type { Session, TimeSegment } from '../contract/types.js'
import type { Store } from '../db/index.js'
import { TrackingService, type TrackingChangeReason } from './tracking.js'

export type TimerChangeReason = 'start' | 'stop' | 'idle' | 'edit'

export interface TimerListener {
  (session: Session | null, reason: TimerChangeReason): void
}

/** A segment, described the way the pre-planner code expects a session to look. */
export function segmentAsSession(segment: TimeSegment): Session {
  return {
    id: segment.id,
    taskId: segment.taskId,
    taskTitle: segment.taskTitle,
    projectName: segment.projectName,
    startedAt: segment.startedAt,
    endedAt: segment.endedAt,
    note: segment.note,
    autoStopped: segment.autoStopped,
    durationMin: segment.durationMin
  }
}

/** Switching and completing have no equivalent in the old vocabulary; both read as a start. */
const asTimerReason = (reason: TrackingChangeReason): TimerChangeReason =>
  reason === 'switch' || reason === 'complete' ? 'start' : reason

export class TimerService {
  readonly tracking: TrackingService

  constructor(store: Store, tracking?: TrackingService) {
    this.tracking = tracking ?? new TrackingService(store)
  }

  onChange(listener: TimerListener): () => void {
    return this.tracking.onChange((segment, reason) => {
      listener(segment ? segmentAsSession(segment) : null, asTimerReason(reason))
    })
  }

  current(): Session | null {
    const segment = this.tracking.currentSegment()
    return segment ? segmentAsSession(segment) : null
  }

  isRunning(): boolean {
    return this.tracking.isRunning()
  }

  start(taskId: string | null, at = Date.now()): Session {
    return segmentAsSession(this.tracking.startRun(taskId, at))
  }

  stop(note?: string, at = Date.now()): Session | null {
    const segment = this.tracking.stopRun(at, note)
    return segment ? segmentAsSession(segment) : null
  }

  toggle(taskId: string | null): Session | null {
    const segment = this.tracking.toggle(taskId)
    return segment ? segmentAsSession(segment) : null
  }

  handleIdle(idleSeconds: number, idleTimeoutMin: number): Session | null {
    const segment = this.tracking.handleIdle(idleSeconds, idleTimeoutMin)
    return segment ? segmentAsSession(segment) : null
  }

  repairOnStartup(now = Date.now()): number {
    return this.tracking.repairOnStartup(now)
  }

  edit(id: string, patch: Parameters<Store['tracking']['updateSegment']>[1]): Session {
    return segmentAsSession(this.tracking.editSegment(id, patch))
  }

  remove(id: string): void {
    this.tracking.removeSegment(id)
  }
}
