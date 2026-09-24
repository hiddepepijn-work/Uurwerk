# Creates Start Menu and Desktop shortcuts for Uurwerk.
#
# This is the quick route: the shortcuts point at the Electron binary inside node_modules,
# so the app must stay in this folder and `npm install` must have been run. Good enough for
# your own machine. A standalone install that survives moving the folder needs a packaged
# build (electron-builder) — that comes later.
#
# Usage:  npm run shortcut
#         npm run shortcut -- -Remove

param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Uurwerk.lnk'
$desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Uurwerk.lnk'

if ($Remove) {
    foreach ($path in @($startMenu, $desktop)) {
        if (Test-Path $path) { Remove-Item $path; Write-Host "Removed $path" }
    }
    return
}

$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$icon = Join-Path $root 'resources\icon.ico'
$build = Join-Path $root 'out\main\index.cjs'

if (-not (Test-Path $electron)) { throw "Electron is missing. Run: npm install" }
if (-not (Test-Path $build)) { throw "No build found. Run: npm run build" }
if (-not (Test-Path $icon)) { throw "No icon found. Save resources\icon-source.png, then run: npm run icons" }

$shell = New-Object -ComObject WScript.Shell

foreach ($path in @($startMenu, $desktop)) {
    $link = $shell.CreateShortcut($path)
    $link.TargetPath = $electron
    $link.Arguments = '.'
    $link.WorkingDirectory = $root
    $link.IconLocation = "$icon,0"
    $link.Description = 'Uurwerk — time tracking, planning and weekly reports'
    $link.WindowStyle = 1
    $link.Save()
    Write-Host "Created $path"
}

Write-Host ''
Write-Host 'Pin it: press Start, type Uurwerk, right-click the result, "Pin to Start".'
