import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

const warn = vi.fn()
vi.mock('./logger.js', () => ({ log: { warn, info: vi.fn() } }))

const { startFocusServer, stopFocusServer } = await import('./focus-server.js')

afterEach(() => stopFocusServer())

describe('focus server', () => {
  it('answers GET /focus with the state and an open CORS header', async () => {
    const server = startFocusServer(() => ({ focus: true, task: 'Rapport', sites: ['x.com'] }), 0)
    await once(server, 'listening')
    const { port } = server.address() as AddressInfo

    const response = await fetch(`http://127.0.0.1:${port}/focus`)
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(await response.json()).toEqual({ focus: true, task: 'Rapport', sites: ['x.com'] })

    expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(404)
    expect((await fetch(`http://127.0.0.1:${port}/focus`, { method: 'POST' })).status).toBe(404)
  })

  it('logs instead of crashing when the port is taken', async () => {
    const { createServer } = await import('node:http')
    const holder = createServer().listen(0, '127.0.0.1')
    await once(holder, 'listening')
    const taken = (holder.address() as AddressInfo).port

    const second = startFocusServer(() => ({ focus: false, task: null, sites: [] }), taken)
    await once(second, 'error')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('in use'))
    holder.close()
  })
})
