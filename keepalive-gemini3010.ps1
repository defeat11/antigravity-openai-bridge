# GEMINI 3010 keepalive watchdog.
# Checks every 10 seconds; if nothing listens on 127.0.0.1:3010,
# restarts node server.js detached and logs the event.
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File keepalive-gemini3010.ps1

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $dir "watchdog.log"

# ── Single-instance guard (anti-duplication) ─────────────────────────
# If another copy of this watchdog is already running, exit immediately.
$script:keepaliveMutex = New-Object System.Threading.Mutex($false, "Global\Gemini3010Keepalive")
if (-not $script:keepaliveMutex.WaitOne(0)) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  duplicate watchdog blocked by mutex (pid $PID)" | Add-Content -Path $log
    exit 0
}
"$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  watchdog acquired mutex (pid $PID)" | Add-Content -Path $log
# ─────────────────────────────────────────────────────────────────────

function Write-WdLog([string]$message) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $message" | Add-Content -Path $log
}

function Save-CrashedLogs {
    # Move the dying instance's stdout/stderr into logs/deaths/ before the new
    # process truncates them. Empty files are skipped: nothing to preserve, and
    # they would only bury the real records under noise.
    $deathDir = Join-Path $dir "logs\deaths"
    if (-not (Test-Path $deathDir)) { New-Item -ItemType Directory -Force -Path $deathDir | Out-Null }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    foreach ($name in @("server.log", "server.err.log")) {
        $src = Join-Path $dir $name
        if (-not (Test-Path $src)) { continue }
        try {
            if ((Get-Item $src).Length -eq 0) { continue }
            Move-Item -Path $src -Destination (Join-Path $deathDir "$stamp-$name") -Force
        } catch {
            Write-WdLog "could not preserve ${name}: $($_.Exception.Message)"
        }
    }
    # Keep the last 40 preserved files; older ones are noise, not evidence.
    try {
        Get-ChildItem -Path $deathDir -File |
            Sort-Object LastWriteTime -Descending |
            Select-Object -Skip 40 |
            Remove-Item -Force -ErrorAction SilentlyContinue
    } catch { }
}

function Test-Port3010 {
    # netstat-based check: any LISTENING socket on 127.0.0.1:3010 or 0.0.0.0:3010.
    return [bool](netstat -ano | Select-String ":3010\s" | Select-String "LISTENING")
}

Write-WdLog "watchdog started (pid $PID)"
$consecutiveFailures = 0

while ($true) {
    try {
        if (Test-Port3010) {
            $consecutiveFailures = 0
        } else {
            $consecutiveFailures++
            Write-WdLog "port 3010 DOWN (streak $consecutiveFailures) -> restarting node server.js"
            # Start-Process TRUNCATES its redirect targets. Restarting therefore
            # erased the stdout/stderr of the very crash that caused the restart,
            # which is why server.err.log kept reading 0 bytes. Rotate both logs
            # aside first, so each life keeps its own record.
            Save-CrashedLogs
            Start-Process -FilePath "node" `
                -ArgumentList "--env-file=.env", "server.js" `
                -WorkingDirectory $dir -WindowStyle Hidden `
                -RedirectStandardOutput (Join-Path $dir "server.log") `
                -RedirectStandardError  (Join-Path $dir "server.err.log")
            Start-Sleep -Seconds 6
            if (Test-Port3010) {
                Write-WdLog "restart OK"
                $consecutiveFailures = 0
            } else {
                Write-WdLog "restart did not take effect yet"
            }
        }
    } catch {
        Write-WdLog "watchdog loop error: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds 10
}
