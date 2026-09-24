import { useCallback, useEffect, useState } from 'react'
import type { TimeSegment } from '@core/contract/types.js'
import { api, events } from '../api/client.js'

/**
 * The open segment and its elapsed seconds.
 *
 * Replaces useTimer: a run now survives switching tasks, so the frontend needs to know
 * which *segment* is open, not just whether a timer runs. The clock is pushed from the
 * main process once a second rather than computed here, so a suspended laptop or a clock
 * change cannot drift away from what is stored.
 */
export function useTracking() {
  const [segment, setSegment] = useState<TimeSegment | null>(null)
  const [elapsedSec, setElapsedSec] = useState(0)
  /**
   * When the whole working stretch began, across task switches.
   *
   * Two clocks, because there are two questions: "how long on this task" (the segment)
   * and "how long have I been working" (the run). Showing only the first makes a switch
   * look like the session was lost.
   */
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null)
  const [runElapsedSec, setRunElapsedSec] = useState(0)

  useEffect(() => {
    const sync = async (): Promise<void> => {
      const [current, run] = await Promise.all([
        api.tracking.currentSegment(),
        api.tracking.currentRun()
      ])
      setSegment(current)
      setRunStartedAt(run?.startedAt ?? null)
      setElapsedSec(current ? Math.floor((Date.now() - current.startedAt) / 1000) : 0)
      setRunElapsedSec(run ? Math.floor((Date.now() - run.startedAt) / 1000) : 0)
    }
    void sync()

    const offChanged = events.on('tracking:segmentChanged', ({ segment: next }) => {
      setSegment(next)
      setElapsedSec(next ? Math.floor((Date.now() - next.startedAt) / 1000) : 0)
      // The run may have started or ended with this change; ask rather than assume.
      void sync()
    })

    const offTick = events.on('timer:tick', ({ elapsedSec: seconds }) => {
      setElapsedSec(seconds)
      setRunStartedAt((started) => {
        if (started !== null) setRunElapsedSec(Math.floor((Date.now() - started) / 1000))
        return started
      })
    })

    return () => {
      offChanged()
      offTick()
    }
  }, [])

  const start = useCallback(async (taskId: string | null) => {
    setSegment(await api.tracking.startRun(taskId))
  }, [])

  const stop = useCallback(async (note?: string) => {
    await api.tracking.stopRun(note)
    setSegment(null)
    setElapsedSec(0)
  }, [])

  /** Closes the current segment and opens the next one inside the same run. */
  const switchTask = useCallback(async (taskId: string | null) => {
    const outcome = await api.tracking.switchTask(taskId)
    setSegment(outcome.segment)
    return outcome
  }, [])

  const completeAndSwitch = useCallback(async (nextTaskId: string | null) => {
    const outcome = await api.tracking.completeAndSwitch(nextTaskId)
    setSegment(outcome.segment)
    return outcome
  }, [])

  const blockAndSwitch = useCallback(async (reason: string, nextTaskId: string | null) => {
    const outcome = await api.tracking.blockAndSwitch(reason, nextTaskId)
    setSegment(outcome.segment)
    return outcome
  }, [])

  return {
    segment,
    /** Seconds on the current task. Resets on a switch — by design. */
    elapsedSec,
    /** Seconds since the working stretch began. Survives switches. */
    runElapsedSec,
    runStartedAt,
    running: segment !== null,
    taskId: segment?.taskId ?? null,
    start,
    stop,
    switchTask,
    completeAndSwitch,
    blockAndSwitch
  }
}

export type Tracking = ReturnType<typeof useTracking>
