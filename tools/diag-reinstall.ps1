# tools/diag-reinstall.ps1 - post-restore-point check + reinstall helper.
# Checks Stream Deck version / running state, re-copies the plugin, and
# relaunches Stream Deck.
$ErrorActionPreference = 'Continue'

Write-Host '== Diagnostics =='
$exe = 'C:\Program Files\Elgato\StreamDeck\StreamDeck.exe'
if (Test-Path $exe) {
    $v = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($exe)
    Write-Host ('Stream Deck exe version: ' + $v.FileVersion)
} else {
    Write-Host 'Stream Deck exe NOT FOUND at expected path'
}

$proc = Get-Process -Name 'StreamDeck' -ErrorAction SilentlyContinue
if ($proc) {
    Write-Host ('Stream Deck running (pid ' + ($proc.Id -join ',') + ')')
} else {
    Write-Host 'Stream Deck not running'
}

$log = Join-Path $env:TEMP 'volume-monitor-streamdeck.log'
if (Test-Path $log) {
    Write-Host '-- last 8 log lines --'
    Get-Content $log -Tail 8
} else {
    Write-Host 'No plugin log found yet'
}

Write-Host ''
Write-Host '== Reinstall =='
$Root = Split-Path -Parent $PSScriptRoot
$PluginDir = Join-Path $Root 'com.tech127x.volume-monitor.sdPlugin'
$Target = Join-Path $env:APPDATA 'Elgato\StreamDeck\Plugins\com.tech127x.volume-monitor.sdPlugin'

$sd = Get-Process -Name 'StreamDeck' -ErrorAction SilentlyContinue
if ($sd) {
    Write-Host 'Closing Stream Deck...'
    Stop-Process -Name 'StreamDeck' -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}
if (Test-Path $Target) {
    Remove-Item -Path $Target -Recurse -Force
}
Copy-Item -Path $PluginDir -Destination $Target -Recurse
Write-Host 'Plugin copied.'

Start-Process -FilePath $exe
Write-Host 'Stream Deck relaunched.'
