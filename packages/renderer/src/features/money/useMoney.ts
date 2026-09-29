import type { IsoDate, MoneyState } from '@core/contract/types.js'
import { useLiveQuery } from '../../hooks/useLiveQuery.js'
import { useToday } from '../../hooks/useToday.js'

/**
 * Geld's one read: the whole state, refetched whenever a Geld write lands. The sums are done
 * here in the renderer with core/money (pure functions), so a slider can recompute the trip
 * projection on every move without a round trip.
 */
export function useMoney(): { state: MoneyState | null; error: string | null; today: IsoDate } {
  const { data, error } = useLiveQuery((client) => client.money.state(), ['money'], [])
  return { state: data, error, today: useToday() }
}
