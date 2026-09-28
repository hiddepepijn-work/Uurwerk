/**
 * The server's live channel (GET /api/events, server-sent events), for syncing at once.
 *
 * Rounds every 30 seconds mean another device's change shows up to half a minute late. The
 * server already announces every change it takes in (a device's push, Jarvis, the calendar
 * timers) on this channel, so a device that listens can pull the moment it happens. The
 * rounds stay as the safety net: a dropped connection only means waiting for the next one.
 *
 * Plain fetch with a streamed body rather than EventSource, because EventSource cannot send
 * the device token in a header. Works in Node (the laptop's main process) and in WKWebView.
 */

const FIRST_RETRY_MS = 2_000
const MAX_RETRY_MS = 30_000

/** Events that mean "data changed on the server"; the rest (keep-alives) are ignored. */
const CHANGE_EVENTS = new Set(['data:invalidated', 'tracking:segmentChanged'])

/** The event names in a chunk of an event stream, and what is left over for the next chunk. */
export function readEvents(buffer: string): { events: string[]; rest: string } {
  const events: string[] = []
  let rest = buffer.replace(/\r\n/g, '\n')
  let cut: number
  while ((cut = rest.indexOf('\n\n')) >= 0) {
    const block = rest.slice(0, cut)
    rest = rest.slice(cut + 2)
    const name = /^event: ?(.+)$/m.exec(block)?.[1]?.trim()
    if (name) events.push(name)
  }
  return { events, rest }
}

/**
 * Listens until stopped, reconnecting with a growing pause after a failure. Calls onChange
 * for each change the server announces (callers debounce). Returns the stop function.
 */
export function watchServer(url: string, token: string, onChange: () => void): () => void {
  let stopped = false
  let controller: AbortController | null = null
  let retry = FIRST_RETRY_MS

  const listen = async (): Promise<void> => {
    while (!stopped) {
      controller = new AbortController()
      try {
        const response = await fetch(`${url}/api/events`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
          signal: controller.signal
        })
        if (!response.ok || !response.body) throw new Error(`The live channel answered ${response.status}.`)
        retry = FIRST_RETRY_MS
        // Connected again: whatever happened while away is picked up by one pull now.
        onChange()
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          const read = readEvents(buffer + decoder.decode(value, { stream: true }))
          buffer = read.rest
          if (read.events.some((name) => CHANGE_EVENTS.has(name))) onChange()
        }
      } catch {
        // Offline, the server restarting, or stopped on purpose: the loop decides.
      }
      if (stopped) return
      await new Promise((resolve) => setTimeout(resolve, retry))
      retry = Math.min(retry * 2, MAX_RETRY_MS)
    }
  }

  void listen()
  return () => {
    stopped = true
    controller?.abort()
  }
}
