# test-bridge.ps1 - sanity check for audio-bridge.ps1 against real Windows
# audio. Spawns the bridge, drives the line protocol, verifies each response,
# restores the original volume, and exits 0 on success / 1 on failure.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\test-bridge.ps1

param(
    [string]$BridgePath = "",
    [int]$TimeoutSeconds = 10
)

$ErrorActionPreference = 'Stop'

if (-not $BridgePath) {
    $BridgePath = Join-Path $PSScriptRoot '..\com.tech127x.volume-monitor.sdPlugin\audio-bridge.ps1'
}
$BridgePath = (Resolve-Path $BridgePath).Path

$global:failures = 0
$script:stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

function Test-Step([string]$Name, [bool]$Ok, [string]$Detail) {
    $elapsed = $script:stopwatch.Elapsed.TotalSeconds.ToString('F1')
    if ($Ok) {
        Write-Host ("[{0,5}s] PASS  {1}" -f $elapsed, $Name) -ForegroundColor Green
    } else {
        Write-Host ("[{0,5}s] FAIL  {1}  {2}" -f $elapsed, $Name, $Detail) -ForegroundColor Red
        $global:failures++
    }
}

function Read-LineWithTimeout([System.Diagnostics.Process]$Proc, [int]$TimeoutMs, [string]$What) {
    $task = $Proc.StandardOutput.ReadLineAsync()
    if (-not $task.Wait($TimeoutMs)) {
        throw "timeout waiting for bridge output ($What)"
    }
    $line = $task.Result
    if ($null -eq $line) { throw "bridge closed its output ($What)" }
    return $line
}

function Send-Cmd([System.Diagnostics.Process]$Proc, [hashtable]$Body, [int]$TimeoutMs) {
    $json = ($Body | ConvertTo-Json -Compress)
    $Proc.StandardInput.WriteLine($json)
    $Proc.StandardInput.Flush()
    $line = Read-LineWithTimeout $Proc $TimeoutMs $Body.cmd
    return ($line | ConvertFrom-Json)
}

Write-Host "Starting audio bridge: $BridgePath"

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'powershell.exe'
$psi.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$BridgePath`""
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true

$proc = [System.Diagnostics.Process]::Start($psi)

try {
    # 1. Ready handshake (Add-Type compile takes a moment)
    try {
        $ready = Read-LineWithTimeout $proc ($TimeoutSeconds * 1000) 'ready'
        $readyObj = $ready | ConvertFrom-Json
        Test-Step 'ready handshake' ($readyObj.event -eq 'ready') $ready
    } catch {
        Test-Step 'ready handshake' $false $_.Exception.Message
        $stderr = $proc.StandardError.ReadToEnd()
        if ($stderr) { Write-Host "  stderr: $stderr" -ForegroundColor DarkGray }
        exit 1
    }

    # 2. ping
    try {
        $r = Send-Cmd $proc @{ cmd = 'ping' } ($TimeoutSeconds * 1000)
        Test-Step 'ping' ($r.ok -and $r.pong) $r.error
    } catch {
        Test-Step 'ping' $false $_.Exception.Message
        exit 1
    }

    # 3. state
    try {
        $r = Send-Cmd $proc @{ cmd = 'state' } ($TimeoutSeconds * 1000)
        if ($r.ok -and -not [string]::IsNullOrEmpty($r.device) -and $r.volume -ge 0 -and $r.volume -le 100) {
            Test-Step 'state' $true ("device='{0}' volume={1} muted={2}" -f $r.device, $r.volume, $r.muted)
        } else {
            Test-Step 'state' $false "device='$($r.device)' volume=$($r.volume) muted=$($r.muted) error=$($r.error)"
            exit 1
        }
        $originalVolume = [int]$r.volume
    } catch {
        Test-Step 'state' $false $_.Exception.Message
        exit 1
    }

    # 4. devices
    try {
        $r = Send-Cmd $proc @{ cmd = 'devices' } ($TimeoutSeconds * 1000)
        if ($r.ok -and $r.devices.Count -ge 1) {
            Test-Step 'devices' $true ("{0} device(s): {1}" -f $r.devices.Count, (($r.devices | ForEach-Object { $_.name }) -join ', '))
        } else {
            Test-Step 'devices' $false "no render devices enumerated (error=$($r.error))"
        }
    } catch {
        Test-Step 'devices' $false $_.Exception.Message
    }

    # 5. sessions
    try {
        $r = Send-Cmd $proc @{ cmd = 'sessions' } ($TimeoutSeconds * 1000)
        if ($r.ok) {
            Test-Step 'sessions' $true ("{0} audio session(s)" -f @($r.sessions).Count)
        } else {
            Test-Step 'sessions' $false "error=$($r.error)"
        }
        $global:firstSessionId = $null
        if (@($r.sessions).Count -gt 0) { $global:firstSessionId = [string]$r.sessions[0].id }
    } catch {
        Test-Step 'sessions' $false $_.Exception.Message
    }

    # 6. setvol round-trip
    try {
        $target = if ($originalVolume -ge 45) { 25 } else { 75 }
        $r1 = Send-Cmd $proc @{ cmd = 'setvol'; volume = $target } ($TimeoutSeconds * 1000)
        $r2 = Send-Cmd $proc @{ cmd = 'state' } ($TimeoutSeconds * 1000)
        $delta = [Math]::Abs([int]$r2.volume - $target)
        Test-Step 'setvol round-trip' ($r1.ok -and $r2.ok -and $delta -le 8) "set $target, read $($r2.volume) (delta $delta)"
    } catch {
        Test-Step 'setvol round-trip' $false $_.Exception.Message
    }

    # 7. mute round-trip
    try {
        $r1 = Send-Cmd $proc @{ cmd = 'mute'; muted = $true } ($TimeoutSeconds * 1000)
        $r2 = Send-Cmd $proc @{ cmd = 'state' } ($TimeoutSeconds * 1000)
        Test-Step 'mute on' ($r1.ok -and $r2.ok -and $r2.muted) "read muted=$($r2.muted)"
        $r3 = Send-Cmd $proc @{ cmd = 'mute'; muted = $false } ($TimeoutSeconds * 1000)
        $r4 = Send-Cmd $proc @{ cmd = 'state' } ($TimeoutSeconds * 1000)
        Test-Step 'mute off' ($r3.ok -and $r4.ok -and -not $r4.muted) "read muted=$($r4.muted)"
    } catch {
        Test-Step 'mute round-trip' $false $_.Exception.Message
    }

    # 8. sessvol round-trip (if any sessions exist)
    if ($global:firstSessionId) {
        try {
            $sid = $global:firstSessionId
            $r0 = Send-Cmd $proc @{ cmd = 'sessions' } ($TimeoutSeconds * 1000)
            $orig = 0
            foreach ($s in @($r0.sessions)) { if ([string]$s.id -eq $sid) { $orig = [int]$s.volume } }
            $tgt = if ($orig -ge 45) { 25 } else { 75 }
            $r1 = Send-Cmd $proc @{ cmd = 'sessvol'; id = $sid; volume = $tgt } ($TimeoutSeconds * 1000)
            $r2 = Send-Cmd $proc @{ cmd = 'sessions' } ($TimeoutSeconds * 1000)
            $readBack = -1
            foreach ($s in @($r2.sessions)) { if ([string]$s.id -eq $sid) { $readBack = [int]$s.volume } }
            $delta = [Math]::Abs($readBack - $tgt)
            Test-Step 'sessvol round-trip' ($r1.ok -and $delta -le 8) "set $tgt, read $readBack (delta $delta)"
            # restore
            [void](Send-Cmd $proc @{ cmd = 'sessvol'; id = $sid; volume = $orig } ($TimeoutSeconds * 1000))
        } catch {
            Test-Step 'sessvol round-trip' $false $_.Exception.Message
        }
    } else {
        Write-Host "  SKIP  sessvol (no audio sessions)" -ForegroundColor DarkYellow
    }

    # 9. restore original master volume
    try {
        $r = Send-Cmd $proc @{ cmd = 'setvol'; volume = $originalVolume } ($TimeoutSeconds * 1000)
        Test-Step 'restore volume' $r.ok "restored $originalVolume"
    } catch {
        Test-Step 'restore volume' $false $_.Exception.Message
    }

    # 10. quit
    try {
        $json = @{ cmd = 'quit' } | ConvertTo-Json -Compress
        $proc.StandardInput.WriteLine($json)
        $proc.StandardInput.Flush()
        if (-not $proc.WaitForExit(3000)) { $proc.Kill() }
        Test-Step 'quit' ($proc.HasExited -and $proc.ExitCode -eq 0) "exit=$($proc.ExitCode)"
    } catch {
        Test-Step 'quit' $false $_.Exception.Message
    }
} finally {
    if (-not $proc.HasExited) { $proc.Kill() }
    $proc.Dispose()
}

$elapsed = $script:stopwatch.Elapsed.TotalSeconds.ToString('F1')
if ($global:failures -eq 0) {
    Write-Host ("All bridge checks passed in {0}s" -f $elapsed) -ForegroundColor Green
    exit 0
} else {
    Write-Host ("{0} bridge check(s) failed in {1}s" -f $global:failures, $elapsed) -ForegroundColor Red
    exit 1
}
