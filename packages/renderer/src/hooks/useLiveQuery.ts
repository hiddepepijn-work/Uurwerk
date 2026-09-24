import { useCallback, useEffect, useRef, useState } from 'react'
import { api, events } from '../api/client.js'
import type { AppEvents } from '@core/contract/events.js'

type Domain = AppEvents['data:invalidated']['domain']

interface Result<T> {
  data: T | null
  error: string | null
  loading: boolean
  refetch: () => void
}

/**
 * Fetch-and-subscribe. The backend tells the frontend when something changed
 * (`data:invalidated`), so nothing in this app polls.
 *
 * `domains` lists which invalidation events should trigger a refetch.
 */
export function useLiveQuery<T>(
  fetcher: (client: typeof api) => Promise<T>,
  domains: Domain[] = [],
  deps: unknown[] = []
): Result<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Keeps the effect from depending on a new function identity every render.
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  const run = useCallback(() => {
    let cancelled = false
    fetcherRef
      .current(api)
      .then((result) => {
        if (cancelled) return
        setData(result)
        setError(null)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  useEffect(() => run(), [run])

  useEffect(() => {
    if (domains.length === 0) return
    return events.on('data:invalidated', (payload) => {
      if (domains.includes(payload.domain)) run()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, domains.join(',')])

  return { data, error, loading, refetch: run }
}
