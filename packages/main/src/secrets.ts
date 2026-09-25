/**
 * Credential storage.
 *
 * Secrets (the SMTP app password, the publish token) are encrypted with Electron's
 * safeStorage, which on Windows means DPAPI — the ciphertext is bound to this Windows user
 * account on this machine. They are written to a file next to the database, never to the
 * repo, never to a config file in plain text, and are never returned to the renderer.
 *
 * The renderer can ask *whether* a secret exists (to render a "configured" badge). It can
 * never ask for the value.
 */

import { safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataRoot } from './paths.js'
import type { SecretKey } from '@backend/host.js'
import { log } from './logger.js'

// The key names are the backend's; this file is only where the laptop keeps the values.
export type { SecretKey }

const file = (): string => join(dataRoot(), 'secrets.json')

type Vault = Partial<Record<SecretKey, string>>

function read(): Vault {
  try {
    const path = file()
    if (!existsSync(path)) return {}
    return JSON.parse(readFileSync(path, 'utf8')) as Vault
  } catch (error) {
    log.warn('Could not read the secret vault; treating it as empty.', error)
    return {}
  }
}

function write(vault: Vault): void {
  writeFileSync(file(), JSON.stringify(vault), { encoding: 'utf8', mode: 0o600 })
}

export function setSecret(key: SecretKey, value: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    // Refuse rather than silently storing a password in plain text.
    throw new Error(
      'OS-level encryption is unavailable, so credentials cannot be stored safely. ' +
        'Use draft mail mode instead.'
    )
  }
  const vault = read()
  if (value) vault[key] = safeStorage.encryptString(value).toString('base64')
  else delete vault[key]
  write(vault)
  log.info(`Secret ${value ? 'stored' : 'cleared'}: ${key}`)
}

/** Main-process use only. Never route this through IPC. */
export function getSecret(key: SecretKey): string | null {
  const stored = read()[key]
  if (!stored) return null
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch (error) {
    log.error(`Could not decrypt secret: ${key}`, error)
    return null
  }
}

export const hasSecret = (key: SecretKey): boolean => Boolean(read()[key])
