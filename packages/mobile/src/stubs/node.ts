/**
 * Stand-ins for the Node modules the shared backend imports.
 *
 * The phone runs the backend in a web view, where there is no file system and no Node.
 * The code paths that need one — writing a .docx, reading a screenshot from disk, the
 * calendar providers — either run on the server (forwarded) or have no meaning on a phone,
 * so reaching one of these is a sentence, not a crash.
 */

const missing = (what: string) => (): never => {
  throw new Error(`${what} is not available on the phone.`)
}

// node:fs
export const existsSync = (): boolean => false
export const readFileSync = missing('Reading a file')
export const writeFileSync = missing('Writing a file')
export const unlinkSync = missing('Deleting a file')
export const renameSync = missing('Moving a file')
export const rmSync = missing('Deleting a file')
export const mkdirSync = missing('Making a folder')
export const mkdtempSync = missing('Making a folder')
export const statSync = missing('Reading a file')
export const appendFileSync = (): void => undefined

// node:fs/promises
export const readFile = missing('Reading a file')

// node:path — enough for building names; no real paths exist here.
export const join = (...parts: string[]): string => parts.filter(Boolean).join('/').replace(/\/+/g, '/')
const parts = (path: string): string[] => path.replaceAll('\\', '/').split('/')
export const basename = (path: string): string => parts(path).pop() ?? ''
export const dirname = (path: string): string => parts(path).slice(0, -1).join('/')
export const extname = (path: string): string => {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot) : ''
}

// node:os
export const tmpdir = (): string => '/tmp'

// nodemailer
export const createTransport = missing('Sending mail')

export default {}

// node-sqlite3-wasm — the laptop's driver. The phone opens sql.js instead (database.ts);
// this only has to exist so core's connection module can be loaded.
export class Database {
  constructor() {
    throw new Error('The phone opens its database with sql.js, not node-sqlite3-wasm.')
  }
}
