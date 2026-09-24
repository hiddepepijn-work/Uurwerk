/**
 * The uploaded files, on disk.
 *
 * Deliberately dumb, and deliberately flat. The desktop app decided what may leave the
 * machine and gave every file a random name; this side stores those bytes under that name
 * and nothing else. There are no folders, no dates in filenames and no metadata, so a
 * directory listing of this server tells a reader nothing it should not know.
 *
 * The one rule enforced here is the name: anything that is not a plain random name with a
 * known extension is refused before it touches the filesystem. That is what stops a PUT of
 * `../../etc/passwd` from being a path at all.
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const EXTENSIONS = new Set(['json', 'jpg', 'jpeg', 'webm', 'png'])

export function isSafeName(name) {
  if (typeof name !== 'string' || !NAME.test(name)) return false
  if (name.includes('..')) return false
  const extension = name.split('.').pop()?.toLowerCase()
  return extension !== undefined && EXTENSIONS.has(extension)
}

export const contentTypeOf = (name) => {
  if (name.endsWith('.json')) return 'application/json; charset=utf-8'
  if (name.endsWith('.webm')) return 'video/webm'
  if (name.endsWith('.png')) return 'image/png'
  return 'image/jpeg'
}

export class BlobStore {
  constructor(directory) {
    this.directory = directory
  }

  async init() {
    await mkdir(this.directory, { recursive: true })
  }

  path(name) {
    if (!isSafeName(name)) throw new Error(`Refusing a name that is not a plain upload name: ${name}`)
    return join(this.directory, name)
  }

  async put(name, bytes) {
    await writeFile(this.path(name), bytes)
  }

  /** Missing is the desired end state of a delete, so it is not an error. */
  async remove(name) {
    await rm(this.path(name), { force: true })
  }

  async read(name) {
    try {
      return await readFile(this.path(name))
    } catch (error) {
      if (error && error.code === 'ENOENT') return null
      throw error
    }
  }

  /**
   * What is on disk, in numbers: how many files, how much of it, and when the last upload
   * arrived. The admin page shows it, so "is publiceren aangekomen" is answerable without
   * an SSH session.
   */
  async stats() {
    let files = 0
    let bytes = 0
    let newest = 0

    for (const name of await readdir(this.directory)) {
      const info = await stat(join(this.directory, name)).catch(() => null)
      if (!info?.isFile()) continue
      files += 1
      bytes += info.size
      newest = Math.max(newest, info.mtimeMs)
    }

    return { files, bytes, newest }
  }

  async readJson(name) {
    const bytes = await this.read(name)
    if (!bytes) return null
    try {
      return JSON.parse(bytes.toString('utf8'))
    } catch {
      return null
    }
  }
}
