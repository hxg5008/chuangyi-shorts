[CmdletBinding()]
param([switch]$Force)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-common.ps1')
$controlLock = $null

try {
    $controlLock = Enter-LocalLock
    $record = Read-LocalRecord
    # Refuse to interrupt generation even if a caller forgets to inspect its own preflight.
    $runningProject = @(Get-LocalPortProcesses | Where-Object { Test-LocalProjectProcess $_ })
    if ($null -ne $record) {
        $recordProcess = Get-LocalProcess -ProcessId $record.processId
        if (Test-LocalProjectProcess $recordProcess $record) { $runningProject += $recordProcess }
    }
    if (-not $Force -and $runningProject.Count -gt 0) {
        $activityJson = & node.exe (Join-Path $PSScriptRoot 'local-active-tasks.cjs')
        if ($LASTEXITCODE -ne 0) { throw 'Cannot verify active tasks. The backend was left running.' }
        $activity = $activityJson | ConvertFrom-Json
        if ($activity.generation -gt 0 -or $activity.text -gt 0) {
            throw ('There are active tasks (generation={0}, text={1}). The backend was left running. Wait for completion, or explicitly use -Force to interrupt.' -f $activity.generation, $activity.text)
        }
    }
    $stoppedIds = @()
    if ($null -ne $record) {
        $candidate = Get-LocalProcess -ProcessId $record.processId
        if (Test-LocalProjectProcess $candidate $record) {
            Stop-LocalProjectProcess $candidate $record
            $stoppedIds += $candidate.ProcessId
        }
    }

    # Recover a running instance if its PID record was removed or became stale.
    foreach ($owner in @(Get-LocalPortProcesses)) {
        if (Test-LocalProjectProcess $owner) {
            Stop-LocalProjectProcess $owner
            $stoppedIds += $owner.ProcessId
        }
    }
    Clear-LocalRecord
    if ($stoppedIds.Count -gt 0) { Write-Host ('Chuangyi Shorts stopped. PID: {0}' -f ($stoppedIds -join ', ')) }
    else { Write-Host 'No running backend for this project was found. Other programs were left running.' }
} catch {
    Write-Error $_.Exception.Message -ErrorAction Continue
    exit 1
} finally {
    if ($null -ne $controlLock) { $controlLock.Dispose() }
}
