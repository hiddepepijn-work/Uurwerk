/**
 * Claude Code's link to Uurwerk: read the planning, and plan with the same tools as Jarvis.
 *
 *   npm run link -- status [days]        today and the days after it, plus the open tasks
 *   npm run link -- tool <name> [json]   one Jarvis tool, e.g. create_task, plan_range, confirm
 *   npm run link -- tools                the tool names and what they do
 *
 * With the app open, everything goes through its loopback link (packages/main/src/
 * claude-link.ts), so a write runs inside the app and shows up on screen. With the app
 * closed, the CLI opens the database itself. A status read never writes: it works on a copy.
 *
 * `status --hook` is what the Claude Code SessionStart hook calls: it prints the day for the
 * model to read, and says plainly when nothing is planned.
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createBackend } from '@backend/create.js'
import { installHost, unavailable, type Host } from '@backend/host.js'
import { buildImplementation } from '@backend/implementation.js'
import type { TimeTrackerAPI } from '@core/contract/api.js'
import { runTool, TOOLS } from '@core/services/jarvis-tools.js'

const PORT = 47812
const appData = process.env.APPDATA ?? join(process.env.USERPROFILE ?? '.', 'AppData', 'Roaming')
const dataRoot = join(appData, 'uurwerk', 'uurwerk')
const realDb = join(dataRoot, 'app.db')
const tokenFile = join(dataRoot, 'claude-link.token')

const isoDate = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

/** The tool through the running app, or null when the app is not listening. */
async function viaApp(name: string, input: Record<string, unknown>): Promise<unknown | null> {
  if (!existsSync(tokenFile)) return null
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-uurwerk-token': readFileSync(tokenFile, 'utf8').trim() },
      body: JSON.stringify({ name, input }),
      signal: AbortSignal.timeout(15_000)
    })
    const body = (await response.json()) as { result?: unknown; error?: string }
    if (body.error) throw new Error(body.error)
    return body.result
  } catch (error) {
    if (error instanceof Error && /fetch failed|ECONNREFUSED|timed out|aborted/i.test(`${error.message} ${String(error.cause)}`)) return null
    throw error
  }
}

/** Whether Uurwerk is open: its focus server (port 47811) answers only while it runs. */
async function appRunning(): Promise<boolean> {
  try {
    await fetch('http://127.0.0.1:47811/focus', { signal: AbortSignal.timeout(2_000) })
    return true
  } catch {
    return false
  }
}

function localApi(readOnly: boolean): TimeTrackerAPI {
  const work = mkdtempSync(join(tmpdir(), 'uurwerk-link-'))
  let db = realDb
  if (readOnly) {
    db = join(work, 'app.db')
    copyFileSync(realDb, db)
  }
  installHost({
    emit: () => undefined,
    secrets: { get: () => null, set: () => undefined, has: () => false },
    reportDir: () => work,
    openPath: unavailable('open'),
    openExternal: unavailable('open'),
    showItemInFolder: () => undefined,
    capture: { markNow: unavailable('capture'), buildTimelapse: unavailable('timelapse') },
    startup: { getLoginItemStatus: unavailable('startup'), setAutoLaunch: unavailable('startup') },
    window: { minimizeToTray: unavailable('w'), closeQuickAdd: unavailable('w'), quit: unavailable('w') },
    relaunch: unavailable('relaunch'),
    sync: { status: unavailable('s'), pair: unavailable('s'), now: unavailable('s'), unpair: unavailable('s') },
    fileFor: (artifact) => artifact.path
  } satisfies Host)
  return buildImplementation(createBackend(db)) as unknown as TimeTrackerAPI
}

async function tool(name: string, input: Record<string, unknown>, readOnly: boolean): Promise<unknown> {
  const live = await viaApp(name, input)
  if (live !== null) return live
  if (!readOnly && (await appRunning())) {
    throw new Error('Uurwerk is open but its Claude link does not answer (old build?). Rebuild and restart the app, or close it.')
  }
  return runTool(localApi(readOnly), name, input)
}

async function status(days: number, hook: boolean): Promise<void> {
  const today = new Date()
  const from = isoDate(today)
  const to = isoDate(new Date(today.getTime() + (days - 1) * 86_400_000))
  const snapshot = String(await tool('get_snapshot', { from, to, tasks: true }, true))

  // The first day's lines run until the next unindented line.
  const lines = snapshot.split('\n')
  const todayLines: string[] = []
  for (const line of lines.slice(1)) {
    if (!line.startsWith('  ')) break
    todayLines.push(line)
  }
  const planned = todayLines.filter((line) => /\((planner|zelf|jarvis)\)/.test(line))
  const emptyDays = lines.filter((line, index) => /^\S/.test(line) && lines[index + 1] === '  (niets)').map((line) => line)
  const late = lines.filter((line) => line.includes('TE LAAT')).length

  if (hook) {
    console.log('[Uurwerk-dagcheck — van scripts/claude-link.ts]')
    if (planned.length === 0) {
      console.log(
        'VANDAAG STAAT ER NIETS GEPLAND IN UURWERK. Zeg dit meteen aan het begin van je eerste antwoord tegen Hidde, ' +
          'stel per project/subproject voor wat erin moet en plan het echt in (taak aanmaken + inplannen via ' +
          '`npm run link -- tool ...` in Documents\\Uurwerk), na zijn ja.'
      )
    } else {
      console.log(`Vandaag ${planned.length} blok(ken) gepland. Noem kort wat er vandaag staat als het past.`)
    }
    if (emptyDays.length > 0) console.log(`Lege dagen komende ${days}: ${emptyDays.join(', ')}`)
    if (late > 0) console.log(`${late} open taak/taken over de deadline: vraag of ze af zijn, verzet of geschrapt.`)
    console.log('Tijdens het werk: komt er iets open dat Hidde nog moet doen, stel zelf een Uurwerk-to-do voor (met tijdsinschatting, en vraag of er voorbereiding nodig is).')
    console.log('')
  }
  console.log(snapshot)
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  if (!existsSync(realDb)) throw new Error(`Geen database op ${realDb}`)

  switch (command) {
    case 'status': {
      const hook = rest.includes('--hook')
      const days = Number(rest.find((arg) => /^\d+$/.test(arg)) ?? 7)
      await status(Math.min(14, Math.max(1, days)), hook)
      return
    }
    case 'tool': {
      const [name, json] = rest
      if (!name) throw new Error('Welke tool? Zie: npm run link -- tools')
      const spec = TOOLS.find((entry) => entry.name === name)
      const result = await tool(name, json ? (JSON.parse(json) as Record<string, unknown>) : {}, !spec?.writes && name !== 'confirm')
      console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2))
      return
    }
    case 'tools':
      for (const spec of TOOLS) console.log(`${spec.name}${spec.writes ? ' (schrijft)' : ''}: ${spec.description}`)
      return
    default:
      console.log('Gebruik: status [dagen] [--hook] | tool <naam> [json] | tools')
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
