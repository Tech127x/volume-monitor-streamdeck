# install.ps1 - installs the Volume Monitor Stream Deck plugin.
#
# Copies the com.tech127x.volume-monitor.sdPlugin folder into the Stream
# Deck plugins directory, then asks you to restart Stream Deck.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginDir = Join-Path $Root 'com.tech127x.volume-monitor.sdPlugin'
$PluginsRoot = Join-Path $env:APPDATA 'Elgato\StreamDeck\Plugins'
$Target = Join-Path $PluginsRoot 'com.tech127x.volume-monitor.sdPlugin'

if (-not (Test-Path $PluginDir)) {
    Write-Host "ERROR: plugin folder not found: $PluginDir" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $PluginsRoot)) {
    New-Item -ItemType Directory -Path $PluginsRoot -Force | Out-Null
}

Write-Host "Installing Volume Monitor plugin..."
Write-Host "  from: $PluginDir"
Write-Host "  to:   $Target"

# Stream Deck keeps the plugin folder locked while it runs the plugin.
$sd = Get-Process -Name 'StreamDeck' -ErrorAction SilentlyContinue
if ($sd) {
    Write-Host "Stream Deck is running - closing it so the plugin can be updated..." -ForegroundColor Yellow
    Stop-Process -Name 'StreamDeck' -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

# Remove any previous install first: Copy-Item with an existing directory
# destination would nest the plugin folder instead of replacing it.
if (Test-Path $Target) {
    Remove-Item -Path $Target -Recurse -Force
}
Copy-Item -Path $PluginDir -Destination $Target -Recurse

Write-Host ""
Write-Host "Installed." -ForegroundColor Green
Write-Host "Start Stream Deck to load the updated plugin." -ForegroundColor Yellow

$sd = Get-Process -Name 'StreamDeck' -ErrorAction SilentlyContinue
if ($sd) {
    Write-Host "Stream Deck is running. Restart it (or right-click the tray icon -> Quit, then reopen) to load the plugin." -ForegroundColor Yellow
} else {
    Write-Host "Start Stream Deck and add a 'Volume Monitor' action to a Stream Deck+ dial or keypad." -ForegroundColor Yellow
}
