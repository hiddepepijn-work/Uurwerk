/**
 * The upload half of publishing.
 *
 * Deliberately dumb: it PUTs bytes to a URL and DELETEs them again. Every decision about
 * *what* may be uploaded was already made in core/services/publish.ts, so nothing here has
 * to be trusted with a rule.
 *
 * ── The endpoint contract ─────────────────────────────────────────────────────────────
 *
 *   PUT    {publishUrl}/{name}    Authorization: Bearer {publishToken}    body: bytes
 *   DELETE {publishUrl}/{name}    Authorization: Bearer {publishToken}
 *
 * `{name}` is a flat, random filename — no folders, no dates. Anything that speaks that
 * contract works: an R2 or S3 bucket behind a small worker, a webdav share, a five-line
 * handler on your own server. The page that reads `index.json` must sit behind a login;
 * this uploader assumes the bucket is not world-readable and cannot verify that for you.
 *
 * Nothing is enabled by default. With `publishEnabled` off, or no URL, or no token, every
 * call throws with a sentence naming what is missing — the app never quietly does nothing
 * while telling you a day was published.
 */

import type { PublishAudience, PublishIndex, PublishedDay } from '@core/contract/types.js'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

import type { Backend } from './create.js'
import { log } from './log.js'
import { host } from './host.js'

/** The live status payload always lands on the same name — the page has to find it. */
export const SNAPSHOT_NAME = 'snapshot.json'
/**
 * One index per audience, on a fixed name: it is the entry point, and it is what the login
 * sits in front of. The server hands a reader the index of their own role and no other, so
 * the supervisor's listing and the teacher's listing never share a URL.
 */
export const INDEX_NAMES: Record<PublishAudience, string> = {
  supervisor: 'index-supervisor.json',
  teacher: 'index-teacher.json'
}

const TIMEOUT_MS = 30_000

interface Target {
  baseUrl: string
  token: string
}

function target(backend: Backend): Target {
  const settings = backend.store.settings.get()

  if (!settings.publishEnabled) {
    throw new Error('Publishing is switched off. Turn it on under Settings → Publishing first.')
  }

  const baseUrl = settings.publishUrl.trim().replace(/\/+$/, '')
  if (!baseUrl) {
    throw new Error('No publish URL is set. Add the address of your own upload endpoint under Settings → Publishing.')
  }
  if (!/^https:\/\//i.test(baseUrl)) {
    // Plain HTTP would put the token and the screenshots on the wire in the clear.
    throw new Error('The publish URL must start with https://.')
  }

  const token = host().secrets.get('publishToken')
  if (!token) {
    throw new Error('No publish token is stored. Add one under Settings → Publishing, or switch publishing off.')
  }

  return { baseUrl, token }
}

/** True when a publish would work — used to refuse early, before anything is stamped. */
export function isConfigured(backend: Backend): boolean {
  // On the server the library is right here: nothing to configure.
  if (host().publishSink) return true
  try {
    target(backend)
    return true
  } catch {
    return false
  }
}

async function send(
  { baseUrl, token }: Target,
  name: string,
  // A string for JSON, an ArrayBuffer for bytes: both are BodyInit as they stand, which
  // avoids the copy-and-cast dance that a Buffer or a typed array needs.
  init: { method: 'PUT'; body: ArrayBuffer | string; contentType: string } | { method: 'DELETE' }
): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const response = await fetch(`${baseUrl}/${encodeURIComponent(name)}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.method === 'PUT' ? { 'Content-Type': init.contentType } : {})
      },
      ...(init.method === 'PUT' ? { body: init.body } : {}),
      signal: controller.signal
    })

    // 404 on delete is the desired end state, not a failure: the copy is gone either way.
    if (!response.ok && !(init.method === 'DELETE' && response.status === 404)) {
      throw new Error(`${init.method} ${name} failed: ${response.status} ${response.statusText}`)
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`The upload of ${name} timed out after ${TIMEOUT_MS / 1000} seconds.`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function uploadJson(
  backend: Backend,
  name: string,
  value: PublishedDay | PublishIndex | object
): Promise<void> {
  const sink = host().publishSink
  if (sink) return sink.put(name, new TextEncoder().encode(JSON.stringify(value)))

  await send(target(backend), name, {
    method: 'PUT',
    body: JSON.stringify(value),
    contentType: 'application/json'
  })
}

/**
 * Uploads a file from disk under its random remote name.
 *
 * The bytes are read here and nowhere else: a frame that was never approved is never even
 * opened, because it never reaches this function.
 */
export async function uploadFile(
  backend: Backend,
  localPath: string,
  remoteName: string
): Promise<void> {
  const bytes = await readFile(localPath)
  const sink = host().publishSink
  if (sink) {
    await sink.put(remoteName, new Uint8Array(bytes))
    log.info('Published a file.', { as: remoteName, from: basename(localPath) })
    return
  }
  const contentType = remoteName.endsWith('.webm') ? 'video/webm' : 'image/jpeg'

  await send(target(backend), remoteName, {
    method: 'PUT',
    // A Buffer is a view into a shared pool, so slice out this file's own bytes rather
    // than handing the whole pool to fetch.
    body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    contentType
  })
  log.info('Uploaded a published file.', { as: remoteName, from: basename(localPath) })
}

/**
 * Deletes remote copies.
 *
 * Every name is attempted even if an earlier one fails, and the failures are collected —
 * stopping at the first error would leave the rest of a revoked day online.
 */
export async function deleteRemote(backend: Backend, names: string[]): Promise<void> {
  const sink = host().publishSink
  if (sink) {
    for (const name of names) await sink.remove(name)
    return
  }
  const resolved = target(backend)
  const failed: string[] = []

  for (const name of names) {
    try {
      await send(resolved, name, { method: 'DELETE' })
    } catch (error) {
      failed.push(name)
      log.error('Could not delete a published file.', { name, error })
    }
  }

  if (failed.length > 0) {
    throw new Error(
      `${failed.length} published file(s) could not be deleted, so the day is still online. ` +
        'Nothing has been marked as unpublished — try again, or remove them at your host.'
    )
  }
}
