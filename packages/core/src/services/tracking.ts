/**
 * Tracking: one run, many segments.
 *
 * The old model said one session equals one task, which meant that switching tasks either
 * lost the continuity of the working stretch or forced a gap into the log. A run now stays
 * open across switches, and each task gets its own segment inside it.
 *
 * Invariants this service owns:
 *   1. At most one run and one segment are open at any moment.
 *   2. Segments inside a run are adjacent: the instant that closes one opens the next, so
 *      a run contains no gap the user did not actually take.
 *   3. Idle time is never billed. The watchdog closes the segment backdated to when idling
 *      began, not to when it was noticed.
 *   4. `countsAsStageHours` is resolved once, at segment start, and stored. Reclassifying
 *      an area afterwards must not rewrite hours that were already reported.
 *   5. Switching into an area that does not count as stage hours is reported to the caller,
 *      which is expected to confirm it rather than let it happen silently.
 */

import type { Area, CompletionReason, TimeSegment, TrackingRun } from '../contract/types.js'
import type { Store } from '../db/index.js'
import { MINUTE_MS } from '../util/time.js'

/** A run open longer than this was forgotten, not worked. */
const MAX_RUN_MS = 16 * 60 * MINUTE_MS

/**
 * A segment shorter than this was a mis-click, not work.
 *
 * Without this, clicking through a few tasks leaves a trail of zero-minute segments that
 * clutter the timeline and make "sessions today" meaningless. Discarding them loses no
 * real time — the next segment starts at the same instant the discarded one did, so the
 * run stays continuous and every second is still accounted for.
 */
const MIN_SEGMENT_MS = 20_000

export type TrackingChangeReason = 'start' | 'stop' | 'switch' | 'complete' | 'idle' | 'edit'

export interface TrackingListener {
  (segment: TimeSegment | null, reason: TrackingChangeReason): void
}

export interface SwitchResult {
  segment: TimeSegment
  /**
   * True when the new task's area does not count toward internship hours while the
   * previous one did. The UI is expected to have confirmed this with the user.
   */
  leavesStageHours: boolean
}

export class TrackingService {
  private listeners = new Set<TrackingListener>()

  constructor(private readonly store: Store) {}

  onChange(listener: TrackingListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(segment: TimeSegment | null, reason: TrackingChangeReason): void {
    for (const listener of this.listeners) listener(segment, reason)
  }

  // ------------------------------------------------------------------ state

  currentRun(): TrackingRun | null {
    return this.store.tracking.currentRun()
  }

  currentSegment(): TimeSegment | null {
    return this.store.tracking.currentSegment()
  }

  isRunning(): boolean {
    return this.store.tracking.currentRun() !== null
  }

  /**
   * Resolves a task's area and its hour rule. A task inherits its project's area when it
   * has none of its own; an unknown area never counts as stage hours, because absence of
   * a rule is not permission to claim the time.
   */
  resolveArea(taskId: string | null): { area: Area | null; countsAsStageHours: boolean } {
    if (!taskId) return { area: null, countsAsStageHours: false }

    const task = this.store.tasks.get(taskId)
    if (!task?.areaId) return { area: null, countsAsStageHours: false }

    const area = this.store.areas.get(task.areaId)
    return { area, countsAsStageHours: area?.countsAsStageHours ?? false }
  }

  // ------------------------------------------------------------- run control

  /** Starts a run and its first segment. An already-running run is reused. */
  startRun(taskId: string | null, at = Date.now()): TimeSegment {
    const existing = this.currentRun()
    if (existing) return this.switchTask(taskId, at).segment

    return this.store.db.transaction(() => {
      const run = this.store.tracking.startRun(at)
      const { area, countsAsStageHours } = this.resolveArea(taskId)

      const segment = this.store.tracking.startSegment({
        trackingRunId: run.id,
        taskId,
        areaId: area?.id ?? null,
        countsAsStageHours,
        at
      })

      if (taskId) this.markInProgress(taskId)
      this.emit(segment, 'start')
      return segment
    })
  }

  /** Closes the open segment and the run around it. */
  stopRun(at = Date.now(), note?: string, reason: CompletionReason = 'stopped'): TimeSegment | null {
    const run = this.currentRun()
    if (!run) return null

    return this.store.db.transaction(() => {
      const segment = this.currentSegment()
      const endedAt = segment ? Math.max(at, segment.startedAt) : at

      // Started and stopped within seconds: nothing worth recording.
      if (segment && endedAt - segment.startedAt < MIN_SEGMENT_MS) {
        this.store.tracking.removeSegment(segment.id)
        if (this.store.tracking.segmentsForRun(run.id).length === 0) {
          this.store.tracking.endRun(run.id, run.startedAt)
        } else {
          this.store.tracking.endRun(run.id, Math.max(at, run.startedAt))
        }
        this.emit(null, reason === 'idle' ? 'idle' : 'stop')
        return null
      }

      const closed = segment
        ? this.store.tracking.endSegment(segment.id, endedAt, reason, {
            note,
            autoStopped: reason === 'idle'
          })
        : null

      this.store.tracking.endRun(run.id, Math.max(at, run.startedAt))
      this.emit(null, reason === 'idle' ? 'idle' : 'stop')
      return closed
    })
  }

  /** Start if stopped, stop if running — what the start/stop hotkey does. */
  toggle(taskId: string | null): TimeSegment | null {
    return this.isRunning() ? this.stopRun() : this.startRun(taskId)
  }

  // ---------------------------------------------------------- task switching

  /**
   * Moves to another task without ending the run. The same timestamp closes the current
   * segment and opens the next, so the run stays continuous.
   */
  switchTask(taskId: string | null, at = Date.now()): SwitchResult {
    const run = this.currentRun()
    if (!run) return { segment: this.startRun(taskId, at), leavesStageHours: false }

    return this.store.db.transaction(() => {
      const previous = this.currentSegment()
      const wasStageHours = previous?.countsAsStageHours ?? false

      // Same task already running: nothing to do, and no spurious segment boundary.
      if (previous && previous.taskId === taskId) {
        return { segment: previous, leavesStageHours: false }
      }

      const boundary = previous ? Math.max(at, previous.startedAt) : at

      // A segment you left within seconds was a mis-click. Drop it and let the new one
      // begin where it did, so no time is lost and the timeline stays readable.
      let startAt = boundary
      if (previous) {
        if (boundary - previous.startedAt < MIN_SEGMENT_MS) {
          startAt = previous.startedAt
          this.store.tracking.removeSegment(previous.id)
        } else {
          this.store.tracking.endSegment(previous.id, boundary, 'switched')
        }
      }

      const { area, countsAsStageHours } = this.resolveArea(taskId)
      const segment = this.store.tracking.startSegment({
        trackingRunId: run.id,
        taskId,
        areaId: area?.id ?? null,
        countsAsStageHours,
        at: startAt
      })

      if (taskId) this.markInProgress(taskId)
      this.emit(segment, 'switch')

      return { segment, leavesStageHours: wasStageHours && !countsAsStageHours }
    })
  }

  /** Completes the current task and moves to the next one in the same run. */
  completeAndSwitch(nextTaskId: string | null, at = Date.now()): SwitchResult {
    return this.store.db.transaction(() => {
      const previous = this.currentSegment()

      // Completing a *task* depends on there being one; closing the *segment* does not.
      // Skipping the close for a task-less segment left it open while the next one started
      // on top of it — and since only the newest open segment is ever read back, the older
      // one stayed invisible while counting toward every total for as long as the row lived.
      let startAt = at

      if (previous) {
        const boundary = Math.max(at, previous.startedAt)
        if (previous.taskId) this.store.tasks.complete(previous.taskId, true)

        // Same mis-click rule as switchTask: a segment left within seconds is not work.
        if (boundary - previous.startedAt < MIN_SEGMENT_MS) {
          startAt = previous.startedAt
          this.store.tracking.removeSegment(previous.id)
        } else {
          this.store.tracking.endSegment(previous.id, boundary, 'completed')
          startAt = boundary
        }
      }

      const run = this.currentRun()
      if (!run) return { segment: this.startRun(nextTaskId, at), leavesStageHours: false }

      const { area, countsAsStageHours } = this.resolveArea(nextTaskId)
      const segment = this.store.tracking.startSegment({
        trackingRunId: run.id,
        taskId: nextTaskId,
        areaId: area?.id ?? null,
        countsAsStageHours,
        at: startAt
      })

      if (nextTaskId) this.markInProgress(nextTaskId)
      this.emit(segment, 'complete')

      return {
        segment,
        leavesStageHours: (previous?.countsAsStageHours ?? false) && !countsAsStageHours
      }
    })
  }

  /** Marks the current task blocked and moves on. */
  blockAndSwitch(reason: string, nextTaskId: string | null, at = Date.now()): SwitchResult {
    return this.store.db.transaction(() => {
      const previous = this.currentSegment()
      if (previous?.taskId) {
        this.store.tracking.endSegment(previous.id, Math.max(at, previous.startedAt), 'blocked')
        this.store.tasks.update(previous.taskId, { status: 'blocked', blockedReason: reason })
      }
      return this.switchTask(nextTaskId, at)
    })
  }

  // -------------------------------------------------------------------- idle

  /**
   * Called by the idle watchdog. Closes the run backdated to when idling began, so the
   * minutes spent away from the machine never enter the log.
   *
   * Returns what was running even when stopRun discarded it as shorter than
   * MIN_SEGMENT_MS. The watchdog arms its resume from this return value: a resumed task
   * that got under twenty seconds of input before the next pause would otherwise never
   * re-arm, and every pause after it would leave the timer off without a word.
   */
  handleIdle(idleSeconds: number, idleTimeoutMin: number): TimeSegment | null {
    if (!this.isRunning()) return null
    if (idleSeconds < idleTimeoutMin * 60) return null

    const current = this.currentSegment()
    return this.stopRun(Date.now() - idleSeconds * 1000, undefined, 'idle') ?? current
  }

  /**
   * Startup repair, in two parts.
   *
   * First any segment that was left open behind a newer one — a run may only ever have one
   * open segment, and an older one that survived is pure over-reporting, because it goes on
   * counting until now while never being the segment anyone can see or stop.
   *
   * Then the run itself: one left open by a crash is capped rather than credited in full.
   * We know it ran too long, we do not know when it really ended, and over-reporting hours
   * is the worse error.
   */
  repairOnStartup(now = Date.now()): number {
    let repaired = this.closeOrphanSegments(now)

    const run = this.currentRun()
    if (run && now - run.startedAt > MAX_RUN_MS) {
      this.stopRun(run.startedAt + MAX_RUN_MS, undefined, 'idle')
      repaired += 1
    }

    return repaired
  }

  /**
   * Closes every open segment except the newest, which is the live one.
   *
   * Each orphan is closed where its own run ended, or failing that where the segment that
   * superseded it began — never at "now", which would credit hours that were never worked.
   */
  private closeOrphanSegments(now: number): number {
    const open = this.store.tracking.openSegments()
    if (open.length <= 1) return 0

    const live = open[open.length - 1]!

    return this.store.db.transaction(() => {
      let closed = 0
      for (const orphan of open.slice(0, -1)) {
        const run = this.store.tracking.getRun(orphan.trackingRunId)
        const endedAt = Math.max(
          orphan.startedAt,
          Math.min(run?.endedAt ?? live.startedAt, live.startedAt, now)
        )
        this.store.tracking.endSegment(orphan.id, endedAt, 'stopped', { autoStopped: true })
        closed += 1
      }
      return closed
    })
  }

  // ------------------------------------------------------------- corrections

  /**
   * Announces that segments changed underneath the running state, without changing it.
   *
   * The attribution service rewrites closed segments in bulk; the open one, if any, is
   * untouched. Every screen that shows hours still has to hear about it, and this is the
   * one channel those screens listen on.
   */
  notifyEdited(): void {
    this.emit(this.currentSegment(), 'edit')
  }

  /**
   * Corrects one segment.
   *
   * Moving time to a different task re-resolves the area and the stage-hour rule from that
   * task. This is not the thing invariant 4 forbids: that one is about *reclassifying an
   * area*, where the work never changed and the rule did, and rewriting reported hours would
   * be dishonest. Here the work itself is being reassigned, and leaving the old snapshot
   * behind is what would be dishonest — it is why an hour you fixed by hand used to stay out
   * of your internship total for good.
   */
  editSegment(
    id: string,
    patch: Parameters<Store['tracking']['updateSegment']>[1]
  ): TimeSegment {
    const current = this.store.tracking.getSegment(id)
    const reassigned =
      current !== null && patch.taskId !== undefined && patch.taskId !== current.taskId

    const resolved = reassigned
      ? (() => {
          const { area, countsAsStageHours } = this.resolveArea(patch.taskId ?? null)
          return { areaId: area?.id ?? null, countsAsStageHours }
        })()
      : {}

    const segment = this.store.tracking.updateSegment(id, { ...resolved, ...patch })
    this.emit(this.currentSegment(), 'edit')
    return segment
  }

  removeSegment(id: string): void {
    this.store.tracking.removeSegment(id)
    this.emit(this.currentSegment(), 'edit')
  }

  /** Working on a task moves it out of 'open' without the user having to say so. */
  private markInProgress(taskId: string): void {
    const task = this.store.tasks.get(taskId)
    if (task && task.status === 'open') {
      this.store.tasks.update(taskId, { status: 'in_progress' })
    }
  }
}
