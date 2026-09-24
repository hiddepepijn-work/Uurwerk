/**
 * The small amount of HTTP this server has to speak, in one place.
 *
 * Reading a body is where a public endpoint is usually careless, so it is not careless here:
 * every read has a maximum and aborts the connection the moment it is exceeded, rather than
 * buffering whatever arrives and finding out afterwards.
 */

export const SECURITY_HEADERS = {
  // No third-party anything: every byte this server serves comes from this server.
  'Content-Security-Policy':
    "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin'
}

export function send(response, status, body, headers = {}) {
  response.writeHead(status, { ...SECURITY_HEADERS, ...headers })
  response.end(body)
}

export const sendHtml = (response, status, html) =>
  send(response, status, html, { 'Content-Type': 'text/html; charset=utf-8' })

export const sendText = (response, status, text) =>
  send(response, status, text, { 'Content-Type': 'text/plain; charset=utf-8' })

export const redirect = (response, location, headers = {}) =>
  send(response, 303, '', { Location: location, ...headers })

/** Reads at most `limit` bytes, and hangs up rather than buffering more. */
export function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0

    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('too-large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

export function parseCookies(header) {
  const out = {}
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return out
}

export function cookie(name, value, { maxAge, secure }) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/** The client address, from the proxy only when you have said there is one. */
export function clientAddress(request, trustProxy) {
  if (trustProxy) {
    const forwarded = request.headers['x-forwarded-for']
    if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim()
  }
  return request.socket.remoteAddress ?? 'unknown'
}

/** Escapes text for HTML. Everything rendered by this server goes through it. */
export const escape = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
