/**
 * Everything the server needs to know, read once from the environment.
 *
 * Nothing here has a default that weakens anything. The publish token has no default at
 * all — a server that accepts uploads from anyone is worse than one that refuses to start —
 * and cookies are marked Secure unless you explicitly say the server is running without
 * TLS, which is only ever true on a laptop.
 */

import { resolve } from 'node:path'

const bool = (value) => value === '1' || value === 'true' || value === 'yes'

export function readConfig(env = process.env) {
  const dataDir = resolve(env.UURWERK_DATA_DIR ?? './data')

  return {
    port: Number(env.UURWERK_PORT ?? 8787),
    host: env.UURWERK_HOST ?? '127.0.0.1',
    dataDir,
    blobDir: resolve(dataDir, 'blobs'),
    usersFile: resolve(dataDir, 'users.json'),
    sessionsFile: resolve(dataDir, 'sessions.json'),
    devicesFile: resolve(dataDir, 'devices.json'),
    /**
     * The bearer token of the old upload door (PUT /publish/…). Optional now: a synced
     * server publishes into its own library. Empty = that door stays shut.
     */
    publishToken: env.UURWERK_PUBLISH_TOKEN ?? '',
    /** How long a login lasts. Short by default: this is somebody else's data. */
    sessionHours: Number(env.UURWERK_SESSION_HOURS ?? 12),
    /**
     * Off unless you are testing on localhost. With TLS terminated by Caddy or nginx in
     * front, the connection the browser makes is https even though this server speaks http,
     * so the cookie must still be marked Secure.
     */
    insecureCookies: bool(env.UURWERK_INSECURE_COOKIES),
    /** Read the client address from X-Forwarded-For. Only ever true behind your own proxy. */
    trustProxy: bool(env.UURWERK_TRUST_PROXY),
    title: env.UURWERK_TITLE ?? 'Uurwerk'
  }
}

/** Fails loudly at startup rather than quietly at the first upload. */
export function checkConfig(config) {
  const problems = []
  if (config.publishToken && config.publishToken.length < 24) {
    problems.push('UURWERK_PUBLISH_TOKEN is shorter than 24 characters. Generate one with: openssl rand -hex 32')
  }
  if (!Number.isFinite(config.port) || config.port <= 0) {
    problems.push('UURWERK_PORT is not a number.')
  }
  return problems
}
