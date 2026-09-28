/**
 * Tells the Chrome focus extension (packages/main/chrome-focus) whether focus is on.
 * Loopback only, one route: GET /focus → { focus, task, sites }. The extension polls it;
 * when this app is not running the request fails and the extension lifts its blocks.
 */

import { createServer, type Server } from 'node:http'

import { log } from './logger.js'

export const FOCUS_PORT = 47811

export interface FocusState {
  focus: boolean
  /** Title of the focus task, or null when focus is off. */
  task: string | null
  /** Hostnames to block; subdomains are blocked too. */
  sites: string[]
}

let server: Server | null = null

/** Returns the server; `port` is only overridden by tests. */
export function startFocusServer(state: () => FocusState, port = FOCUS_PORT): Server {
  stopFocusServer()

  const instance = createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Cache-Control', 'no-store')

    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'GET')
      response.writeHead(204).end()
      return
    }
    if (request.method !== 'GET' || request.url?.split('?')[0] !== '/focus') {
      response.writeHead(404).end()
      return
    }
    try {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(state()))
    } catch (error) {
      log.warn('Focus server: could not read the focus state.', error)
      response.writeHead(500).end()
    }
  })

  // Something else on the port (a second Uurwerk, say): log it and carry on — the laptop
  // guard does not need the server.
  instance.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') log.warn(`Focus server: port ${port} is in use; Chrome blocking is off.`)
    else log.warn('Focus server failed.', error)
    if (server === instance) server = null
  })

  instance.listen(port, '127.0.0.1')
  server = instance
  return instance
}

export function stopFocusServer(): void {
  server?.close()
  server = null
}
