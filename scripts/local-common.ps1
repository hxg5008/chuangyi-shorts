# Shared helpers for the local Windows deployment. Keep this file ASCII.
$script:LocalRepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$script:LocalBackendDir = Join-Path $script:LocalRepoRoot 'backend'
$script:LocalEntryPath = Join-Path $script:LocalBackendDir 'src\index.ts'
$script:LocalRuntimeDir = Join-Path $script:LocalRepoRoot 'data\local-runtime'
$script:LocalRecordPath = Join-Path $script:LocalRuntimeDir 'backend-process.json'
$script:LocalPidPath = Join-Path $script:LocalRuntimeDir 'backend.pid'
$script:LocalStdoutPath = Join-Path $script:LocalRuntimeDir 'backend.stdout.log'
$script:LocalStderrPath = Join-Path $script:LocalRuntimeDir 'backend.stderr.log'
$script:LocalBindHost = '0.0.0.0'
$script:LocalPort = 5679
$script:LocalPublicOrigin = ''
$networkPath = Join-Path $script:LocalRepoRoot 'network.json'
if (Test-Path -LiteralPath $networkPath -PathType Leaf) {
    $network = Get-Content -LiteralPath $networkPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $script:LocalBindHost = [string]$network.host
    $script:LocalPort = [int]$network.port
    $script:LocalPublicOrigin = [string]$network.public_origin
    $parsedAddress = $null
    if (-not [Net.IPAddress]::TryParse($script:LocalBindHost, [ref]$parsedAddress)) { throw 'network.json host must be an IP address.' }
    if ($script:LocalPort -lt 1 -or $script:LocalPort -gt 65535) { throw 'network.json port must be between 1 and 65535.' }
    if ($script:LocalPublicOrigin) {
        $publicUri = [Uri]$script:LocalPublicOrigin
        if ($publicUri.Scheme -notin @('http','https') -or $publicUri.UserInfo -or $publicUri.Query -or $publicUri.Fragment -or $publicUri.AbsolutePath -ne '/') { throw 'network.json public_origin must be a bare HTTP(S) origin, including the port when needed.' }
        $script:LocalPublicOrigin = $publicUri.GetLeftPart([UriPartial]::Authority)
    }
}
$browserHost = if ($script:LocalBindHost -in @('0.0.0.0','::')) { 'localhost' } elseif ($script:LocalBindHost.Contains(':')) { '[' + $script:LocalBindHost + ']' } else { $script:LocalBindHost }
$script:LocalUrl = 'http://' + $browserHost + ':' + $script:LocalPort
$probeHost = if ($script:LocalBindHost -eq '0.0.0.0') { '127.0.0.1' } elseif ($script:LocalBindHost -eq '::') { '[::1]' } else { $browserHost }
$script:LocalHealthUrl = 'http://' + $probeHost + ':' + $script:LocalPort + '/api/v1/health'
$script:LocalHealthError = ''

function Get-LocalSystemProxy($Settings = $null) {
    if ($null -eq $Settings) {
        $Settings = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
    }
    if ($null -eq $Settings -or $Settings.ProxyEnable -ne 1) { return $null }
    $server = [string]$Settings.ProxyServer
    $schemes = @{}
    foreach ($entry in ($server -split ';')) {
        if ($entry -match '^\s*(https|http)\s*=\s*(.*?)\s*$') { $schemes[$Matches[1]] = $Matches[2] }
    }
    $candidates = @($schemes['https'], $schemes['http'], $server.Trim())
    foreach ($candidate in $candidates) {
        if ($candidate -match '^(127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})$') {
            $proxyPort = [int]$Matches[2]
            if ($proxyPort -gt 0 -and $proxyPort -le 65535) { return 'http://' + $candidate }
        }
    }
    return $null
}

function Enter-LocalLock {
    New-Item -ItemType Directory -Path $script:LocalRuntimeDir -Force | Out-Null
    $lockPath = Join-Path $script:LocalRuntimeDir 'control.lock'
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        try {
            return [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        } catch [IO.IOException] {
            Start-Sleep -Milliseconds 200
        }
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Another local start or stop operation is running. Try again shortly.'
}

function Get-LocalProcess([int]$ProcessId) {
    Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = {0}' -f $ProcessId) -ErrorAction SilentlyContinue
}

function Test-LocalProjectProcess($Process, $Record = $null) {
    if ($null -eq $Process -or [string]::IsNullOrWhiteSpace($Process.ExecutablePath)) { return $false }
    if ([IO.Path]::GetFileName($Process.ExecutablePath) -ine 'node.exe') { return $false }
    $entryPattern = '(?i)(?:"|\s)' + [regex]::Escape($script:LocalEntryPath) + '(?:"|\s|$)'
    if ($Process.CommandLine -notmatch $entryPattern) { return $false }
    if ($null -ne $Record) {
        if ($Record.repoRoot -ine $script:LocalRepoRoot -or $Record.entryPath -ine $script:LocalEntryPath) { return $false }
        if ($Record.executablePath -ine $Process.ExecutablePath) { return $false }
        if ($Record.creationTimeUtc -ne $Process.CreationDate.ToUniversalTime().ToString('o')) { return $false }
    }
    return $true
}

function Read-LocalRecord {
    if (-not (Test-Path -LiteralPath $script:LocalRecordPath -PathType Leaf)) { return $null }
    try {
        $record = Get-Content -LiteralPath $script:LocalRecordPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($null -eq $record.processId -or [int]$record.processId -le 0 -or -not $record.creationTimeUtc) { return $null }
        return $record
    } catch { return $null }
}

function Write-LocalRecord($Process) {
    $record = [ordered]@{
        processId = [int]$Process.ProcessId
        creationTimeUtc = $Process.CreationDate.ToUniversalTime().ToString('o')
        executablePath = $Process.ExecutablePath
        entryPath = $script:LocalEntryPath
        repoRoot = $script:LocalRepoRoot
        url = $script:LocalUrl
        bindHost = $script:LocalBindHost
        port = $script:LocalPort
    }
    $temporary = $script:LocalRecordPath + '.tmp'
    $record | ConvertTo-Json | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $script:LocalRecordPath -Force
    [string]$Process.ProcessId | Set-Content -LiteralPath $script:LocalPidPath -Encoding ASCII
}

function Clear-LocalRecord {
    Remove-Item -LiteralPath $script:LocalRecordPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $script:LocalPidPath -Force -ErrorAction SilentlyContinue
}

function Get-LocalPortProcesses {
    $listeners = @(Get-NetTCPConnection -LocalPort $script:LocalPort -State Listen -ErrorAction SilentlyContinue)
    foreach ($ownerId in @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)) {
        if ($ownerId -gt 0) { Get-LocalProcess -ProcessId $ownerId }
    }
}

function Test-LocalHealth([int]$ExpectedProcessId = 0) {
    $response = $null
    $reader = $null
    try {
        # Health probes never use the model proxy, PAC or Windows system proxy.
        # Numeric loopback also avoids localhost resolving to an unbound family.
        $request = [Net.HttpWebRequest]::Create($script:LocalHealthUrl)
        $request.Proxy = $null
        $request.Timeout = 2000
        $request.ReadWriteTimeout = 2000
        $request.KeepAlive = $false
        $response = $request.GetResponse()
        $reader = [IO.StreamReader]::new($response.GetResponseStream())
        $health = $reader.ReadToEnd() | ConvertFrom-Json
        if ($health.status -ne 'ok') { $script:LocalHealthError = 'The health endpoint did not report ready.'; return $false }
        if ($ExpectedProcessId -gt 0 -and [int]$health.processId -ne $ExpectedProcessId) {
            $script:LocalHealthError = 'The endpoint belongs to another or older backend process. Stop the old instance before starting this version.'
            return $false
        }
        $script:LocalHealthError = ''
        return $true
    } catch { $script:LocalHealthError = $_.Exception.Message; return $false }
    finally { if ($null -ne $reader) { $reader.Dispose() }; if ($null -ne $response) { $response.Dispose() } }
}

function Stop-LocalProjectProcess($Process, $Record = $null) {
    $current = Get-LocalProcess -ProcessId $Process.ProcessId
    if ($null -eq $current) { return }
    if (-not (Test-LocalProjectProcess $current $Record)) {
        throw 'Process identity changed. Refusing to stop an unrelated process.'
    }
    Stop-Process -Id $current.ProcessId -Force -ErrorAction Stop
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        if ($null -eq (Get-LocalProcess -ProcessId $current.ProcessId)) { return }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'The backend process did not exit within 10 seconds.'
}
