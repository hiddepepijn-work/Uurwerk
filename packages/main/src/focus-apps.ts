/**
 * The pure half of the laptop focus: which running programs to close, and how the settings'
 * free-text lists are read. No Electron and no child processes here, so it can be tested.
 */

/** A running process as the focus guard sees it. */
export interface RunningProcess {
  pid: number
  /** Lower case, without ".exe". */
  name: string
  /** Has a visible main window — only those are candidates in allow mode. */
  windowed: boolean
}

/**
 * Windows itself, and the tools to get out of trouble. Never closed, whatever the allow list
 * says: closing explorer takes the taskbar with it, and a focus guard that closes Task
 * Manager or the terminal would be impossible to stop.
 */
export const SYSTEM_PROCESSES: ReadonlySet<string> = new Set([
  'explorer',
  'applicationframehost',
  'systemsettings',
  'textinputhost',
  'shellexperiencehost',
  'startmenuexperiencehost',
  'searchhost',
  'searchapp',
  'lockapp',
  'taskmgr',
  'windowsterminal',
  'openconsole',
  'powershell',
  'pwsh',
  'cmd',
  'conhost',
  'rtkuwp',
  // This laptop's own hardware consoles (Acer), same kind as Realtek's above.
  'aqauserps',
  'acerpurifiedvoiceapp',
  'dwm',
  'csrss',
  'winlogon',
  'sihost',
  'ctfmon'
])

/** Process name as compared everywhere: trimmed, lower case, no ".exe". */
export function processKey(name: string): string {
  return name.trim().toLowerCase().replace(/\.exe$/, '')
}

/** A comma-separated or listed set of process names, normalised and without blanks. */
export function processList(names: readonly string[]): string[] {
  return names.map(processKey).filter(Boolean)
}

export function isSystemProcess(name: string): boolean {
  const key = processKey(name)
  // NVIDIA's overlay and its helpers come under several names ("NVIDIA Overlay", "nvcontainer" …).
  return SYSTEM_PROCESSES.has(key) || key.startsWith('nvidia')
}

/**
 * Parses lines of "pid,windowed,name" as printed by the PowerShell one-liner in focus-guard.
 * The name comes last so a comma inside it cannot shift the other fields.
 */
export function parseProcessLines(out: string): RunningProcess[] {
  const list: RunningProcess[] = []
  for (const line of out.split(/\r?\n/)) {
    const match = /^\s*(\d+),(True|False),(.+?)\s*$/i.exec(line)
    if (!match) continue
    list.push({ pid: Number(match[1]), windowed: match[2]!.toLowerCase() === 'true', name: processKey(match[3]!) })
  }
  return list
}

export interface AllowListInput {
  running: readonly RunningProcess[]
  allowed: readonly string[]
  /** Asked to close on the previous check: pid → name. */
  pending: ReadonlyMap<number, string>
  /** This app's own processes, by pid — never touched. */
  ownPids: ReadonlySet<number>
  /** This app's own executable names (e.g. "electron", "uurwerk") — never touched. */
  ownNames: ReadonlySet<string>
}

export interface AllowListPlan {
  /** Ask to close (CloseMainWindow): windowed, not allowed, not asked before. */
  close: RunningProcess[]
  /** Still running after being asked last time: force it. */
  kill: RunningProcess[]
}

/**
 * Allow-list focus: every program with a window that is neither allowed, part of Windows,
 * nor this app, is asked to close. One that was asked on the previous check and is still
 * there (same pid, same name — windowed or hidden to the tray) is killed instead.
 */
export function planAllowListClose(input: AllowListInput): AllowListPlan {
  const allowed = new Set(processList(input.allowed))
  const spared = (proc: RunningProcess): boolean =>
    input.ownPids.has(proc.pid) || input.ownNames.has(proc.name) || allowed.has(proc.name) || isSystemProcess(proc.name)

  const close: RunningProcess[] = []
  const kill: RunningProcess[] = []
  for (const proc of input.running) {
    if (spared(proc)) continue
    if (input.pending.get(proc.pid) === proc.name) kill.push(proc)
    else if (proc.windowed) close.push(proc)
  }
  return { close, kill }
}

/** "https://www.YouTube.com/watch" → "www.youtube.com". Blank or unreadable entries drop out. */
export function siteKey(site: string): string {
  return site
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/?#:].*$/, '')
    .replace(/^\*\./, '')
    .replace(/\.$/, '')
}

export function siteList(sites: readonly string[]): string[] {
  return [...new Set(sites.map(siteKey).filter((site) => /^[a-z0-9.-]+\.[a-z0-9-]+$/.test(site)))]
}
