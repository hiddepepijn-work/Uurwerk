/**
 * ★ SECURITY-CRITICAL ★
 *
 * The two accounts, and how a password is checked.
 *
 * There is no sign-up, no password reset by e-mail and no "remember me". Accounts are made
 * on the server with the `uurwerk-users` command and there are meant to be two of them: the
 * supervisor at the internship and the teacher at school. Fewer moving parts is the whole
 * security model — every feature not built here is a feature that cannot be abused.
 *
 * Passwords are stored as scrypt hashes with a random 16-byte salt, never as anything
 * reversible, and are compared with a timing-safe equal. A username that does not exist is
 * still put through a hash of the same cost, so "no such user" and "wrong password" take
 * the same time and the login page cannot be used to find out who has an account.
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)

/** Cost parameters. N=2^16 takes roughly a tenth of a second, which is the point. */
const KEY_LENGTH = 64
const OPTIONS = { N: 65536, r: 8, p: 1, maxmem: 128 * 65536 * 8 * 2 }

/**
 * Three roles, and only one of them can change anything.
 *
 * `admin` is you. It reads both of the other views — so you can check what each of them
 * actually sees before a meeting instead of hoping — and it is the only role that can make
 * an account, reset a password or take a day off the server by hand.
 */
export const ROLES = ['admin', 'supervisor', 'teacher']

/** The roles that read published days. `admin` borrows one of these to look. */
export const READER_ROLES = ['supervisor', 'teacher']

export const ROLE_LABELS = {
  admin: 'Beheer',
  supervisor: 'Stagebegeleider',
  teacher: 'Docent'
}

export async function hashPassword(password) {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, KEY_LENGTH, OPTIONS)
  return { salt: salt.toString('hex'), hash: key.toString('hex') }
}

async function matches(password, salt, hash) {
  const key = await scrypt(password, Buffer.from(salt, 'hex'), KEY_LENGTH, OPTIONS)
  const stored = Buffer.from(hash, 'hex')
  if (stored.length !== key.length) return false
  return timingSafeEqual(key, stored)
}

export class UserStore {
  constructor(file) {
    this.file = file
  }

  async list() {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed.users) ? parsed.users : []
    } catch (error) {
      if (error && error.code === 'ENOENT') return []
      throw error
    }
  }

  async save(users) {
    // 0600: the file holds password hashes, and nothing else on the box needs to read it.
    await writeFile(this.file, JSON.stringify({ users }, null, 2), { mode: 0o600 })
  }

  async upsert({ username, role, password }) {
    if (!ROLES.includes(role)) throw new Error(`Unknown role: ${role}. Use one of ${ROLES.join(', ')}.`)
    if (typeof password !== 'string' || password.length < 12) {
      throw new Error('A password of at least 12 characters, please. This is somebody else’s data.')
    }

    const users = await this.list()
    const { salt, hash } = await hashPassword(password)
    const next = users.filter((user) => user.username !== username)
    next.push({ username, role, salt, hash, createdAt: Date.now() })
    await this.save(next)
    return { username, role }
  }

  /**
   * Removes an account, unless it is the last way in.
   *
   * Deleting the only admin locks you out of your own server, and the way back is an SSH
   * session and the command line. Refusing is friendlier than being right.
   */
  async remove(username) {
    const users = await this.list()
    const going = users.find((user) => user.username === username)
    if (!going) return false

    if (going.role === 'admin' && users.filter((user) => user.role === 'admin').length === 1) {
      throw new Error('Dat is de laatste beheerder. Maak eerst een andere aan.')
    }

    await this.save(users.filter((user) => user.username !== username))
    return true
  }

  /** True when nobody has an account yet — the server then says so instead of a login. */
  async isEmpty() {
    return (await this.list()).length === 0
  }

  /**
   * The user, or null. Never says which half was wrong, and takes the same time either way.
   */
  async verify(username, password) {
    const users = await this.list()
    const user = users.find((candidate) => candidate.username === username)

    if (!user) {
      // A decoy of the same cost, so a missing account is indistinguishable from a wrong
      // password by timing. The result is thrown away.
      await scrypt(password ?? '', randomBytes(16), KEY_LENGTH, OPTIONS)
      return null
    }

    const ok = await matches(password ?? '', user.salt, user.hash)
    return ok ? { username: user.username, role: user.role } : null
  }
}
