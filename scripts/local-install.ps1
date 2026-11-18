[CmdletBinding()]
param([switch]$SkipFrontendBuild)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction Stop
$npmCommand = Get-Command npm.cmd -CommandType Application -ErrorAction Stop
$nodeVersion = & $nodeCommand.Source -p 'process.versions.node'
if ($LASTEXITCODE -ne 0) { throw 'Unable to read the Node.js version.' }
$version = [version]$nodeVersion
if ($version.Major -lt 22 -or ($version.Major -eq 22 -and $version.Minor -lt 13)) {
    throw 'Node.js 22.13 or newer is required. Node.js 24 x64 matches the tested Windows environment.'
}

function Invoke-ProjectNpm([string]$Directory, [string[]]$Arguments) {
    Push-Location -LiteralPath $Directory
    try {
        & $npmCommand.Source @Arguments
        if ($LASTEXITCODE -ne 0) { throw ('npm failed in {0} (exit {1}). Review the output above.' -f $Directory, $LASTEXITCODE) }
    } finally { Pop-Location }
}

Write-Host ('Installing this source version with Node.js {0}.' -f $nodeVersion)
Invoke-ProjectNpm (Join-Path $repoRoot 'backend') @('ci', '--include=dev', '--no-audit', '--no-fund')
if (-not $SkipFrontendBuild) {
    Invoke-ProjectNpm (Join-Path $repoRoot 'frontend') @('ci', '--include=dev', '--no-audit', '--no-fund')
    Invoke-ProjectNpm (Join-Path $repoRoot 'frontend') @('run', 'generate')
} elseif (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'frontend\.output\public\index.html') -PathType Leaf)) {
    throw 'The prebuilt frontend is missing. Run again without -SkipFrontendBuild.'
}

Write-Host 'Installation complete. Run the start shortcut in the project root.'
Write-Host 'Network settings: network.json (host, port, public_origin).'
Write-Host 'Model services and API keys are configured in the application Settings page.'
