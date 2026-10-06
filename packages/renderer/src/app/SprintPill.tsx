import { useEffect, useState } from 'react'

import { IDLE_SPRINT, sprintAt, type SprintState } from '@core/domain/sprint.js'

import { api, events } from '../api/client.js'
import { CloseIcon } from '../ui/icons.js'

/**
 * "5 sec" on screen: a big 5, 4, 3, 2, 1 while the countdown sound plays, then a small pill
 * with the ten minutes running down. Its own timer — the hours are counted elsewhere.
 */
export function SprintPill({ compact }: { compact: boolean }) {
  const [sprint, setSprint] = useState<SprintState>(IDLE_SPRINT)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    void api.sprint.status().then(setSprint).catch(() => undefined)
    return events.on('sprint:changed', setSprint)
  }, [])

  const active = sprint.phase !== 'idle'
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 200)
    return () => clearInterval(timer)
  }, [active])

  const state = sprintAt(sprint, now)
  if (state.phase === 'idle' || state.focusAt === null || state.endsAt === null) return null

  if (state.phase === 'countdown') {
    const left = Math.max(1, Math.ceil((state.focusAt - now) / 1000))
    return (
      <div className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center bg-bg/70 backdrop-blur-sm">
        <span key={left} className="animate-toast-in text-[160px] leading-none font-black text-accent tabular-nums">
          {left}
        </span>
      </div>
    )
  }

  const seconds = Math.max(0, Math.ceil((state.endsAt - now) / 1000))
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  const justStarted = now - state.focusAt < 1500
  return (
    <div
      className={`fixed left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-card py-1.5 pr-1.5 pl-4 text-sm font-bold shadow-[0_12px_40px_rgba(0,0,0,0.4)] ${
        compact ? 'bottom-[calc(env(safe-area-inset-bottom)+84px)]' : 'top-[68px]'
      } ${justStarted ? 'animate-toast-in' : ''}`}
    >
      <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
      <span className="text-text-dim">{justStarted ? 'Go!' : 'Focus'}</span>
      <span className="tabular-nums">{clock}</span>
      <button
        onClick={() => void api.sprint.stop().catch(() => undefined)}
        className="flex h-7 w-7 items-center justify-center rounded-full text-text-dim transition-colors hover:bg-input hover:text-text"
        aria-label="Stop focus-timer"
        title="Stop"
      >
        <CloseIcon size={14} />
      </button>
    </div>
  )
}
