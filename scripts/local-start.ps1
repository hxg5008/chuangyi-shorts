[CmdletBinding()]
param(
    [switch]$NoBrowser,
    [ValidateRange(5, 180)]
    [int]$TimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-common.ps1')
$controlLock = $null
$newProcess = $null
$newRecord = $null

try {
    $controlLock = Enter-LocalLock
    $record = Read-LocalRecord
    $existing = $null
    if ($null -ne $record) {
        $candidate = Get-LocalProcess -ProcessId $record.processId
        if (Test-LocalProjectProcess $candidate $record) { $existing = $candidate }
    }

    $portProcesses = @(Get-LocalPortProcesses)
    foreach ($owner in $portProcesses) {
        if (-not (Test-LocalProjectProcess $owner)) {
            throw ('Port {0} is occupied by another program (PID {1}). No process was stopped.' -f $script:LocalPort, $owner.ProcessId)
        }
        if ($null -eq $existing) { $existing = $owner }
    }

    if ($null -ne $existing) {
        if ($null -ne $record -and $record.url -ne $script:LocalUrl) {
            throw 'Network configuration changed while the old backend is running. Stop this project first, then start it with the new IP and port.'
        }
        if (-not (Test-LocalHealth -ExpectedProcessId $existing.ProcessId)) {
            throw ('This project is running but its direct health check failed: {0}. {1}' -f $script:LocalHealthUrl, $script:LocalHealthError)
        }
        Write-LocalRecord $existing
        Write-Host ('Chuangyi Shorts is already running: {0} (PID {1})' -f $script:LocalUrl, $existing.ProcessId)
    } else {
        Clear-LocalRecord
        $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction Stop
        $frontend = Join-Path $script:LocalRepoRoot 'frontend\.output\public'
        foreach ($required in @(
            $script:LocalEntryPath,
            (Join-Path $script:LocalBackendDir 'node_modules\tsx\dist\loader.mjs'),
            (Join-Path $frontend 'index.html')
        )) {
            if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw ('Missing dependency or frontend build: {0}' -f $required) }
        }

        $env:NODE_ENV = 'production'
        $env:HOST = $script:LocalBindHost
        $env:PORT = [string]$script:LocalPort
        if ($script:LocalPublicOrigin) {
            $env:HUOBAO_PUBLIC_ORIGIN = $script:LocalPublicOrigin
            $env:PUBLIC_BASE_URL = $script:LocalPublicOrigin
        }
        $env:HUOBAO_DATA_DIR = Join-Path $script:LocalRepoRoot 'data'
        $env:SQLITE_PATH = Join-Path $env:HUOBAO_DATA_DIR 'huobao.sqlite3'
        $env:STORAGE_PATH = Join-Path $env:HUOBAO_DATA_DIR 'static'
        $env:WORKSPACE_PATH = Join-Path $script:LocalBackendDir 'workspace'
        $env:FRONTEND_DIST = $frontend
        $env:MYSQL_AUTO_IMPORT = 'false'

        # Follow an already-enabled loopback Windows proxy unless the user supplied a route.
        $localEnvPath = Join-Path $script:LocalBackendDir '.env'
        $proxyInFile = (Test-Path -LiteralPath $localEnvPath -PathType Leaf) -and
            ([IO.File]::ReadAllText($localEnvPath) -match '(?im)^\s*(?:export\s+)?(?:HUOBAO_PROXY_URL|HTTPS?_PROXY)\s*=')
        if (-not $env:HUOBAO_PROXY_URL -and -not $env:HTTPS_PROXY -and -not $env:HTTP_PROXY -and -not $proxyInFile) {
            $localProxyUrl = Get-LocalSystemProxy
            if ($localProxyUrl) {
                $env:HUOBAO_PROXY_URL = $localProxyUrl
                Write-Host 'Using the enabled local system proxy for model/media requests.'
            }
        }

        $arguments = '--import tsx "{0}"' -f $script:LocalEntryPath
        $newProcess = Start-Process -FilePath $nodeCommand.Source -ArgumentList $arguments -WorkingDirectory $script:LocalBackendDir -WindowStyle Hidden -RedirectStandardOutput $script:LocalStdoutPath -RedirectStandardError $script:LocalStderrPath -PassThru
        $cimProcess = Get-LocalProcess -ProcessId $newProcess.Id
        if (-not (Test-LocalProjectProcess $cimProcess)) { throw 'The backend exited before startup. See data\local-runtime\backend.stderr.log.' }
        Write-LocalRecord $cimProcess
        $newRecord = Read-LocalRecord

        $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
        $ready = $false
        do {
            if (-not (Test-LocalProjectProcess (Get-LocalProcess -ProcessId $newProcess.Id) $newRecord)) { break }
            if (Test-LocalHealth -ExpectedProcessId $newProcess.Id) {
                # The HTTP response identifies the exact verified child process.
                # Get-NetTCPConnection can be restricted on non-admin Windows.
                $ready = $true
                break
            }
            Start-Sleep -Milliseconds 300
        } while ([DateTime]::UtcNow -lt $deadline)
        if (-not $ready) { throw ('Backend startup check failed at {0}: {1}. See data\local-runtime\backend.stderr.log and backend.stdout.log.' -f $script:LocalHealthUrl, $script:LocalHealthError) }
        Write-Host ('Chuangyi Shorts is ready: {0} (PID {1})' -f $script:LocalUrl, $newProcess.Id)
    }

    Write-Host ('Logs: {0}' -f $script:LocalRuntimeDir)
    Write-Host ('Initial admin password (first deployment only): {0}' -f (Join-Path $script:LocalRepoRoot 'data\admin-initial-password.txt'))
    if (-not $NoBrowser) {
        try { Start-Process -FilePath $script:LocalUrl | Out-Null }
        catch { Write-Warning ('Open this address in your browser: {0}' -f $script:LocalUrl) }
    }
} catch {
    if ($null -ne $newProcess) {
        $failed = Get-LocalProcess -ProcessId $newProcess.Id
        if (Test-LocalProjectProcess $failed $newRecord) {
            try { Stop-LocalProjectProcess $failed $newRecord } catch { Write-Warning $_.Exception.Message }
        }
        Clear-LocalRecord
    }
    Write-Error $_.Exception.Message -ErrorAction Continue
    exit 1
} finally {
    if ($null -ne $controlLock) { $controlLock.Dispose() }
}
