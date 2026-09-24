import { useEffect, useMemo, useState } from 'react'
import type { IsoDate, IsoWeek } from '@core/contract/types.js'
import { fromIsoDate, toIsoDate, toIsoWeek } from '@core/util/time.js'

/**
 * The current local calendar day, kept current across midnight.
 *
 * A `toIsoDate(Date.now())` captured at mount goes stale when the app stays open
 * overnight: every "today" query then silently reads yesterday. A midnight timer alone
 * is not enough either — a sleeping laptop skips it — so this also re-checks on focus
 * and visibility, which fire on wake.
 */
export function useToday(): IsoDate {
  const [today, setToday] = useState(() => toIsoDate(Date.now()))

  useEffect(() => {
    const check = (): void => {
      const next = toIsoDate(Date.now())
      setToday((prev) => (next === prev ? prev : next))
    }
    const interval = setInterval(check, 30_000)
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)
    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [])

  return today
}

/** The ISO week containing `useToday`, rolling over with it. */
export function useThisWeek(): IsoWeek {
  const today = useToday()
  return useMemo(() => toIsoWeek(fromIsoDate(today)), [today])
}
