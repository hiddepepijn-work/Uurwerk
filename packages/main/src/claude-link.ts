/**
 * The link for Claude Code: the same tools Jarvis has, over loopback, while the app runs.
 *
 * Claude helps plan the day from the terminal (`scripts/claude-link.ts`). Writing to the
 * database file from a second process while this one has it open would race the app, so a
 * write goes through here and runs in this process, against the open backend — exactly
 * like a tool call from Jarvis.
 *
 * Loopback only, one route: POST /tool { name, input } → the tool's result. A token file
 * in the data folder guards it, so a web page in the browser cannot post to it; unlike the
 * focus server there is no CORS header at all.
 */

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'

import type { Backend } from '@backend/create.js'
import { buildImplementation } from '@backend/implementation.js'
import type { TimeTrackerAPI } from '@core/contract/api.js'
import { runTool, TOOLS } from '@core/services/jarvis-tools.js'

import { emitEvent } from './events.js'
import { log } from './logger.js'
import { dataRoot } from './paths.js'

export const CLAUDE_LINK_PORT = 47812

let server: Server | null = null

/** The shared secret, created on first start; the CLI reads the same file. */
function token(): string {
  const file = join(dataRoot(), 'claude-link.token')
  if (existsSync(file)) return readFileSync(file, 'utf8').trim()
  const fresh = randomBytes(24).toString('hex')
  writeFileSync(file, fresh)
  return fresh
}

export function startClaudeLink(backend: Backend): void {
  const api = buildImplementation(backend) as unknown as TimeTrackerAPI
  const secret = token()

  const instance = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/tool' || request.headers['x-uurwerk-token'] !== secret) {
      response.writeHead(404).end()
      return
    }
    let body = ''
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')))
    request.on('end', () => {
      void (async () => {
        try {
          const { name, input } = JSON.parse(body) as { name: string; input?: Record<string, unknown> }
          const result = await runTool(api, name, input ?? {})
          // A write shows up on the open screens at once, as after a sync.
          if (TOOLS.find((tool) => tool.name === name)?.writes || name === 'confirm') {
            for (const domain of ['tasks', 'planning'] as const) emitEvent('data:invalidated', { domain })
          }
          response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ result }))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          log.warn(`Claude link: ${message}`)
          response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: message }))
        }
      })()
    })
  })

  instance.on('error', (error: NodeJS.ErrnoException) => {
    log.warn(`Claude link failed${error.code === 'EADDRINUSE' ? `: port ${CLAUDE_LINK_PORT} is in use` : ''}.`, error)
    if (server === instance) server = null
  })

  instance.listen(CLAUDE_LINK_PORT, '127.0.0.1')
  server = instance
}

export function stopClaudeLink(): void {
  server?.close()
  server = null
}
