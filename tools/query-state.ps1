# tools/query-state.ps1 - read-only master volume/mute/device query (no changes).
$ErrorActionPreference = 'Stop'
$bridgePath = Join-Path $PSScriptRoot '..\com.tech127x.volume-monitor.sdPlugin\audio-bridge.ps1'
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

$null = $p.StandardOutput.ReadLine()  # ready
$p.StandardInput.WriteLine('{"cmd":"state"}'); $p.StandardInput.Flush()
Write-Host $p.StandardOutput.ReadLine()
$p.StandardInput.WriteLine('{"cmd":"quit"}'); $p.StandardInput.Flush()
$p.WaitForExit(3000) | Out-Null
$p.Dispose()
