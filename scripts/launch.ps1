# Launches Uurwerk and brings its window to the front.
#
# Why this exists: VS Code's integrated terminal sets ELECTRON_RUN_AS_NODE=1, which makes
# Electron start as plain Node and fail with "Cannot read properties of undefined (reading
# 'requestSingleInstanceLock')". This script clears that variable first.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\launch.ps1
#         powershell -ExecutionPolicy Bypass -File scripts\launch.ps1 -Dev

param([switch]$Dev)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

if ($Dev) {
    cmd /c 'npx electron-vite dev'
    return
}

# Build if there is nothing to run yet, then start Electron on the built output directly.
# Going through electron.exe rather than npx keeps this usable from a desktop shortcut.
if (-not (Test-Path 'out\main\index.cjs')) {
    Write-Host 'No build found — building first...'
    cmd /c 'npx electron-vite build'
}

$electron = Join-Path (Get-Location) 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) { throw "Electron is not installed. Run: npm install" }

Start-Process -FilePath $electron -ArgumentList '.' -WorkingDirectory (Get-Location)

# Wait for the window, then raise it — a new Electron window does not always come forward.
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Win {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
}
'@

for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    $window = Get-Process electron -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($window) {
        [Win]::ShowWindow($window.MainWindowHandle, 9) | Out-Null   # SW_RESTORE
        [Win]::SetForegroundWindow($window.MainWindowHandle) | Out-Null
        Write-Host "Uurwerk is up (pid $($window.Id))."
        return
    }
}

Write-Warning 'No Uurwerk window appeared. Check the log at %APPDATA%\uurwerk\uurwerk\uurwerk.log'
