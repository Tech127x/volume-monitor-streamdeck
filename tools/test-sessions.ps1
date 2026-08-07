# test-sessions.ps1 - queries the bridge's sessions/sessions_all commands to
# inspect what Windows reports for audio sessions.
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$bridgePath = Join-Path $scriptDir '..\com.tech127x.volume-monitor.sdPlugin\audio-bridge.ps1'
$bridgePath = (Resolve-Path $bridgePath).Path

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'powershell.exe'
$psi.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$bridgePath`""
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$p = [System.Diagnostics.Process]::Start($psi)

$ready = $p.StandardOutput.ReadLine()
Write-Host "bridge: $ready"

$p.StandardInput.WriteLine('{"cmd":"state"}'); $p.StandardInput.Flush()
Write-Host "state: $($p.StandardOutput.ReadLine())"

$p.StandardInput.WriteLine('{"cmd":"sessions"}'); $p.StandardInput.Flush()
Write-Host "sessions: $($p.StandardOutput.ReadLine())"

$p.StandardInput.WriteLine('{"cmd":"quit"}'); $p.StandardInput.Flush()
$p.WaitForExit(3000) | Out-Null
$p.Dispose()
