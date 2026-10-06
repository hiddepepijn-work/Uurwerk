/**
 * What else the laptop is hearing and saying, for the wake word: a call or music made it think
 * "Hey Jarvis" was said (scores of 0.45–0.49 against a threshold of 0.4 — and a real Dutch
 * "Hé Jarvis" lands just above 0.4, so a higher threshold everywhere would make it deaf).
 *
 *   another app records the microphone   → a call: the wake word stops listening
 *   another app is making sound          → music or a video: it needs a much surer "Hey Jarvis"
 *
 * Windows' own audio sessions say both (assets/audio-probe/audio-probe.ps1, Core Audio):
 * one long-lived PowerShell that prints a line every 1.5 s. Process ids only, nothing is
 * recorded. The app's own processes are left out — the corner window records all the time.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'

import { app } from 'electron'

import { log } from './logger.js'

interface Session {
  pid: number
  name: string
  peak: number
}

/** The Windows audio engine shows up as a session that mirrors everything; it is not an app. */
const NOT_AN_APP = new Set(['audiodg', 'svchost', 'System', 'Idle'])
/** Below this a session is open but silent: a paused player, a tab that played earlier. */
const SOUNDING = 0.02
/** Music has pauses between songs and quiet passages: it counts as playing a while longer. */
const PLAYING_HOLD_MS = 4000

export interface AudioContextNow {
  /** Another app records the microphone: a call, a meeting, a voice message. */
  calling: string | null
  /** Another app made sound in the last few seconds. */
  playing: string | null
}

let probe: ChildProcess | null = null
let calling: string | null = null
let playing: string | null = null
let playingUntil = 0
let lastSaid = ''
let quitting = false

const ownPids = (): Set<number> => new Set(app.getAppMetrics().map((metric) => metric.pid))

function take(line: string): void {
  let sample: { render?: Session[]; capture?: Session[]; error?: string }
  try {
    sample = JSON.parse(line) as typeof sample
  } catch {
    return
  }
  if (sample.error) return
  const own = ownPids()
  const others = (sessions: Session[] | undefined): Session[] =>
    (sessions ?? []).filter((session) => !own.has(session.pid) && !NOT_AN_APP.has(session.name))

  calling = others(sample.capture)[0]?.name ?? null
  const sounding = others(sample.render).filter((session) => session.peak >= SOUNDING)
  if (sounding.length > 0) {
    playing = sounding[0]!.name
    playingUntil = Date.now() + PLAYING_HOLD_MS
  } else if (Date.now() > playingUntil) {
    playing = null
  }

  const said = `${calling ?? '-'}|${playing ?? '-'}`
  if (said !== lastSaid) {
    lastSaid = said
    log.info('Wake word context.', { calling, playing })
  }
}

export function startAudioContext(): void {
  if (process.platform !== 'win32' || probe) return
  const script = join(app.getAppPath(), 'packages', 'main', 'assets', 'audio-probe', 'audio-probe.ps1')
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  probe = child
  let buffered = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    buffered += chunk
    const lines = buffered.split(/\r?\n/)
    buffered = lines.pop() ?? ''
    for (const line of lines) if (line.trim()) take(line)
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (text: string) => log.warn('Audio probe said something on stderr.', { text: text.slice(0, 300) }))
  child.on('exit', (code) => {
    probe = null
    calling = null
    playing = null
    if (app.isReady() && !quitting) {
      log.warn('Audio probe stopped; starting it again in a minute.', { code })
      setTimeout(startAudioContext, 60_000)
    }
  })
}

export function stopAudioContext(): void {
  quitting = true
  probe?.kill()
  probe = null
}

export function audioContextNow(): AudioContextNow {
  return { calling, playing: Date.now() <= playingUntil ? playing : null }
}
