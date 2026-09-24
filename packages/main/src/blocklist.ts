/**
 * Which window has focus right now?
 *
 * Electron has no answer for this. `desktopCapturer` lists windows but not their z-order,
 * and `BrowserWindow` only knows about our own. So we ask Windows directly, through a
 * three-line P/Invoke in PowerShell.
 *
 * That costs a process spawn and about a second of compile time for the inline C#. It is
 * paid at most once per capture interval — five minutes by default — so the cost is real
 * but irrelevant. The alternative was a native module, which on this machine means node-gyp,
 * which means Python and MSVC, neither of which is installed. This is the version that runs.
 *
 * The important behaviour is the failure mode. If the probe fails, times out, or the
 * platform is not Windows, this returns null, and `windowAllows` in core treats null exactly
 * like a blocked window. A broken probe therefore means no screenshots, never unchecked ones.
 */

import { execFile } from 'node:child_process'
import { log } from './logger.js'

const PROBE_TIMEOUT_MS = 6000

/**
 * Inline C# via Add-Type, then one call to GetForegroundWindow.
 *
 * `-NoProfile` matters: a profile that prints a banner would end up parsed as the window
 * title. So does `-NonInteractive` — a prompt here would hang the capture loop.
 */
const PROBE_SCRIPT = [
  'Add-Type @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public class UurwerkFg {',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr h);',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
  '}',
  '"@',
  '$h = [UurwerkFg]::GetForegroundWindow()',
  'if ($h -eq [IntPtr]::Zero) { exit 2 }',
  '$len = [UurwerkFg]::GetWindowTextLength($h)',
  '$sb = New-Object System.Text.StringBuilder ($len + 1)',
  '[void][UurwerkFg]::GetWindowText($h, $sb, $sb.Capacity)',
  'Write-Output $sb.ToString()'
].join('\n')

/**
 * Base64 of UTF-16LE, which is what `-EncodedCommand` expects.
 *
 * Not a micro-optimisation — a correctness fix. The script contains a here-string delimited
 * by `@"` … `"@`, and passing that to `-Command` as a command-line argument puts it through
 * Windows argv quoting, which eats the double quotes and leaves PowerShell parsing C# as
 * PowerShell. Encoding sidesteps every layer of quoting between here and there.
 */
const ENCODED_PROBE = Buffer.from(PROBE_SCRIPT, 'utf16le').toString('base64')

/** Logged once rather than every interval — a missing PowerShell is not news twice. */
let warnedAboutFailure = false

/**
 * The foreground window's title, or null when it cannot be determined.
 *
 * Null is a real answer, not an error: the caller must treat it as "do not capture".
 */
export function foregroundWindowTitle(): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED_PROBE],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 16 },
      (error, stdout) => {
        if (error) {
          if (!warnedAboutFailure) {
            warnedAboutFailure = true
            log.warn(
              'Could not read the foreground window title; automatic capture will stay off. ' +
                'Screenshots are skipped rather than taken blind.',
              { message: error.message }
            )
          }
          resolve(null)
          return
        }

        const title = stdout.trim()
        // An empty title is genuinely unknown — a window with no caption tells us nothing
        // about what is on screen, so it gets the same answer as a failed probe.
        resolve(title.length > 0 ? title : null)
      }
    )
  })
}
