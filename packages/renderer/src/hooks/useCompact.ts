import { useEffect, useState } from 'react'

/** Phone width: below this the side rail gives way to a bottom bar. */
const QUERY = '(max-width: 700px)'

export function useCompact(): boolean {
  const [compact, setCompact] = useState(() => window.matchMedia(QUERY).matches)
  useEffect(() => {
    const media = window.matchMedia(QUERY)
    const onChange = (): void => setCompact(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return compact
}
