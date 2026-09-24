/**
 * The Uurwerk server: one small process on the VPS, doing exactly two jobs.
 *
 *   1. it accepts what the desktop app publishes — a PUT and a DELETE with a bearer token,
 *      which is the contract `packages/main/src/publisher.ts` already speaks
 *   2. it shows those days to two people who log in: the internship supervisor and the
 *      teacher, each seeing only what was prepared for them
 *
 * Nothing is computed here and nothing is decided here. Every rule about what may be seen
 * was applied in the app before the upload, and the one rule this side enforces is that a
 * reader only ever receives files that appear in their own index (see `library.js`).
 *
 * It speaks plain HTTP and expects TLS to be terminated in front of it by Caddy or nginx —
 * see `deploy/`. Bound to localhost by default, so an unconfigured proxy means unreachable
 * rather than exposed.
 */

import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

import { checkConfig, readConfig } from './config.js'
import {
  clientAddress,
  cookie,
  parseCookies,
  readBody,
  redirect,
  send,
  sendHtml,
  sendText
} from './http.js'
import { Library } from './library.js'
import { Sessions } from './sessions.js'
import { BlobStore, contentTypeOf, isSafeName } from './storage.js'
import { READER_ROLES, ROLES, UserStore } from './users.js'
import {
  STYLESHEET,
  adminPage,
  dayPage,
  loginPage,
  messagePage,
  overviewPage,
  setupPage
} from './views.js'

const COOKIE = 'uurwerk_sessie'
const MAX_JSON = 4 * 1024 * 1024
const MAX_FILE = 64 * 1024 * 1024
const MAX_FORM = 4 * 1024

/**
 * Login throttling, per address.
 *
 * Five wrong passwords and the address waits a minute, then two, then four, up to a quarter
 * of an hour. It is not a captcha and it is not meant to be — it is what turns a password
 * of twelve characters from "guessable overnight" into "not guessable".
 */
class Throttle {
  constructor() {
    this.rows = new Map()
  }

  blockedFor(address) {
    const row = this.rows.get(address)
    if (!row || row.until <= Date.now()) return 0
    return Math.ceil((row.until - Date.now()) / 1000)
  }

  fail(address) {
    const row = this.rows.get(address) ?? { fails: 0, until: 0 }
    row.fails += 1
    if (row.fails >= 5) {
      const minutes = Math.min(15, 2 ** (row.fails - 5))
      row.until = Date.now() + minutes * 60_000
    }
    this.rows.set(address, row)
  }

  clear(address) {
    this.rows.delete(address)
  }
}

export async function createUurwerkServer(config = readConfig()) {
  const problems = checkConfig(config)
  if (problems.length > 0) throw new Error(problems.join('\n'))

  const blobs = new BlobStore(config.blobDir)
  await blobs.init()

  const users = new UserStore(config.usersFile)
  const sessions = new Sessions(config.sessionsFile, config.sessionHours)
  const library = new Library(blobs)
  const throttle = new Throttle()

  const secure = !config.insecureCookies
  const site = { siteTitle: config.title }

  /** The session behind a request, or null. Every view route starts with this. */
  const reader = (request) => sessions.get(parseCookies(request.headers.cookie)[COOKIE])

  /**
   * Which reader's view is being rendered.
   *
   * For the supervisor and the teacher that is their own role and nothing else. An admin has
   * no published days of their own, so they borrow one of the two — `?als=teacher` — which
   * is the whole point of the role: seeing exactly what the other person sees, rather than a
   * summary that claims to.
   */
  const viewingRole = (session, url) => {
    if (session.role !== 'admin') return session.role
    const asked = url.searchParams.get('als')
    return READER_ROLES.includes(asked) ? asked : 'supervisor'
  }

  /**
   * The token that has to come back with every form that changes something.
   *
   * SameSite=Strict already keeps a cross-site POST from carrying the cookie, and
   * `form-action 'self'` keeps a page here from posting elsewhere. This is the third lock,
   * on the doors that delete things.
   */
  const csrfOk = (session, value) => {
    const given = Buffer.from(String(value ?? ''))
    const expected = Buffer.from(session.csrf ?? '')
    return given.length === expected.length && given.length > 0 && timingSafeEqual(given, expected)
  }

  /** Reads a posted form, or null when it is too big or malformed. */
  const form = async (request) => {
    try {
      return new URLSearchParams((await readBody(request, MAX_FORM)).toString('utf8'))
    } catch {
      return null
    }
  }

  /**
   * The upload half. One token, compared in full, and nothing else is accepted.
   *
   * A wrong token is a flat 401 with no detail: this endpoint talks to one program, and a
   * program does not need to be told which half of its configuration is wrong.
   */
  const authorised = (request) => {
    const header = request.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (token.length !== config.publishToken.length) return false
    // Constant-time is overkill for a 64-character random token, but it costs nothing.
    let same = 0
    for (let index = 0; index < token.length; index++) {
      same |= token.charCodeAt(index) ^ config.publishToken.charCodeAt(index)
    }
    return same === 0
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error) => {
      console.error('[uurwerk] request failed', error)
      if (!response.headersSent) sendText(response, 500, 'Er ging iets mis.')
      else response.end()
    })
  })

  async function handle(request, response) {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    const path = decodeURIComponent(url.pathname)
    const method = request.method ?? 'GET'

    // ------------------------------------------------------------------ ingest
    if (path.startsWith('/publish/')) {
      return ingest(request, response, path.slice('/publish/'.length), method)
    }

    // ------------------------------------------------------------------ public
    if (path === '/style.css' && method === 'GET') {
      return send(response, 200, STYLESHEET, {
        'Content-Type': 'text/css; charset=utf-8',
        'Cache-Control': 'public, max-age=3600'
      })
    }

    if (path === '/inloggen' && method === 'GET') {
      if (reader(request)) return redirect(response, '/')
      // A server with no accounts has nothing to log in to, and says so rather than showing
      // a form that cannot succeed.
      if (await users.isEmpty()) return sendHtml(response, 200, setupPage(site))
      return sendHtml(response, 200, loginPage({ ...site, problem: null }))
    }

    if (path === '/inloggen' && method === 'POST') return login(request, response)
    if (path === '/uitloggen' && method === 'POST') return logout(request, response)

    // ------------------------------------------------------------ behind a login
    const session = reader(request)
    if (!session) return redirect(response, '/inloggen')

    if (path === '/beheer' || path.startsWith('/beheer/')) {
      if (session.role !== 'admin') {
        return sendHtml(
          response,
          404,
          messagePage({
            ...site,
            user: session,
            title: 'Niet gevonden',
            message: 'Deze pagina bestaat niet.'
          })
        )
      }
      return admin(request, response, session, path, method, url)
    }

    const viewing = viewingRole(session, url)

    if (path === '/' && method === 'GET') {
      const [days, snapshot] = await Promise.all([
        library.days(viewing),
        library.snapshot(viewing)
      ])
      return sendHtml(
        response,
        200,
        overviewPage({ ...site, user: session, days, snapshot, viewing })
      )
    }

    if (path.startsWith('/dag/') && method === 'GET') {
      const day = await library.day(viewing, path.slice('/dag/'.length))
      if (!day) {
        return sendHtml(
          response,
          404,
          messagePage({
            ...site,
            user: session,
            title: 'Niet gevonden',
            message: 'Deze dag is niet (meer) met je gedeeld.'
          })
        )
      }
      return sendHtml(response, 200, dayPage({ ...site, user: session, day, viewing }))
    }

    if (path.startsWith('/bestand/') && method === 'GET') {
      return file(response, viewing, path.slice('/bestand/'.length))
    }

    return sendHtml(
      response,
      404,
      messagePage({
        ...site,
        user: session,
        title: 'Niet gevonden',
        message: 'Deze pagina bestaat niet.'
      })
    )
  }

  // --------------------------------------------------------------------- routes

  async function ingest(request, response, name, method) {
    if (!authorised(request)) return sendText(response, 401, 'Unauthorized')
    if (!isSafeName(name)) return sendText(response, 400, 'Bad name')

    if (method === 'DELETE') {
      await blobs.remove(name)
      library.invalidate()
      return sendText(response, 204, '')
    }

    if (method !== 'PUT') return sendText(response, 405, 'Method not allowed')

    const limit = name.endsWith('.json') ? MAX_JSON : MAX_FILE
    let body
    try {
      body = await readBody(request, limit)
    } catch (error) {
      if (error?.message === 'too-large') return sendText(response, 413, 'Too large')
      throw error
    }

    // A payload that is not JSON would show up as an empty day rather than as an error, so
    // it is rejected at the door.
    if (name.endsWith('.json')) {
      try {
        JSON.parse(body.toString('utf8'))
      } catch {
        return sendText(response, 400, 'Not JSON')
      }
    }

    await blobs.put(name, body)
    library.invalidate()
    return sendText(response, 204, '')
  }

  /**
   * Everything under `/beheer`, for the admin and nobody else.
   *
   * The GET renders the page. Each POST does one thing, checks the session's token first,
   * and then renders the same page again with a line saying what happened — no redirect, so
   * the result is never a page that says nothing after a button was pressed.
   */
  async function admin(request, response, session, path, method, url) {
    let notice = url.searchParams.get('melding')
    let problem = null

    if (method === 'POST') {
      const body = await form(request)
      if (!body || !csrfOk(session, body.get('csrf'))) {
        return sendText(response, 400, 'Dit formulier is verlopen. Herlaad de pagina.')
      }

      try {
        if (path === '/beheer/account') {
          const username = (body.get('username') ?? '').trim()
          const role = body.get('role') ?? ''
          if (!username) throw new Error('Een naam, graag.')
          if (!ROLES.includes(role)) throw new Error('Onbekende rol.')

          await users.upsert({ username, role, password: body.get('password') ?? '' })
          // A new password ends the old logins: otherwise the person you just locked out is
          // still reading, for as long as their session had left.
          sessions.destroyFor(username)
          notice = `${username} opgeslagen.`
        } else if (path === '/beheer/account-verwijderen') {
          const username = body.get('username') ?? ''
          if (username === session.username) {
            throw new Error('Je eigen account verwijderen kan hier niet.')
          }
          const gone = await users.remove(username)
          sessions.destroyFor(username)
          notice = gone ? `${username} verwijderd.` : `${username} bestond niet.`
        } else if (path === '/beheer/dag-intrekken') {
          const date = body.get('date') ?? ''
          const removed = await library.withdraw(date)
          notice = `${date} is offline gehaald; ${removed} bestand(en) verwijderd.`
        } else if (path === '/beheer/sessie-beeindigen') {
          sessions.destroy(body.get('id') ?? '')
          notice = 'Sessie beëindigd.'
        } else {
          return sendText(response, 404, 'Niet gevonden')
        }
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error)
      }
    }

    const [accounts, days, stats] = await Promise.all([
      users.list(),
      library.overview(),
      blobs.stats()
    ])

    return sendHtml(
      response,
      problem ? 400 : 200,
      adminPage({
        ...site,
        user: session,
        accounts: accounts.map(({ username, role }) => ({ username, role })),
        days,
        sessions: sessions.list(),
        stats,
        notice,
        problem
      })
    )
  }

  async function login(request, response) {
    const address = clientAddress(request, config.trustProxy)
    const waiting = throttle.blockedFor(address)
    if (waiting > 0) {
      return sendHtml(
        response,
        429,
        loginPage({
          ...site,
          problem: `Te veel pogingen. Probeer het over ${waiting} seconden opnieuw.`
        })
      )
    }

    let form
    try {
      form = new URLSearchParams((await readBody(request, MAX_FORM)).toString('utf8'))
    } catch {
      return sendText(response, 400, 'Bad request')
    }

    const user = await users.verify(form.get('username') ?? '', form.get('password') ?? '')
    if (!user) {
      throttle.fail(address)
      return sendHtml(
        response,
        401,
        loginPage({ ...site, problem: 'Gebruikersnaam of wachtwoord klopt niet.' })
      )
    }

    throttle.clear(address)
    const id = sessions.create(user)
    // An admin has no days of their own; the page they came for is the admin page.
    return redirect(response, user.role === 'admin' ? '/beheer' : '/', {
      'Set-Cookie': cookie(COOKIE, id, { maxAge: config.sessionHours * 3600, secure })
    })
  }

  async function logout(request, response) {
    sessions.destroy(parseCookies(request.headers.cookie)[COOKIE])
    return redirect(response, '/inloggen', {
      'Set-Cookie': cookie(COOKIE, '', { maxAge: 0, secure })
    })
  }

  async function file(response, viewing, name) {
    if (!isSafeName(name)) return sendText(response, 404, 'Niet gevonden')
    if (!(await library.mayRead(viewing, name))) {
      // Not "forbidden": whether a file exists is itself something this reader is not
      // entitled to know.
      return sendText(response, 404, 'Niet gevonden')
    }

    const bytes = await blobs.read(name)
    if (!bytes) return sendText(response, 404, 'Niet gevonden')

    return send(response, 200, bytes, {
      'Content-Type': contentTypeOf(name),
      // Private: a shared cache in front of this must never keep somebody else's day.
      'Cache-Control': 'private, max-age=300'
    })
  }

  return { server, config }
}

/** `node src/server.js` — the entry point the systemd unit runs. */
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))
if (isMain) {
  const { server, config } = await createUurwerkServer()
  server.listen(config.port, config.host, () => {
    console.log(`[uurwerk] listening on http://${config.host}:${config.port}`)
    console.log(`[uurwerk] data in ${config.dataDir}`)
  })
}
