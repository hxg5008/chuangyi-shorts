[CmdletBinding()]
param([string]$ProjectRoot)
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) { $ProjectRoot = Read-Host '请输入火宝源码根目录（含 backend 的那一层）' }
$root = (Resolve-Path -LiteralPath $ProjectRoot).Path.TrimEnd([IO.Path]::DirectorySeparatorChar)
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'FIX-MANIFEST.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$target = [IO.Path]::GetFullPath((Join-Path $root 'backend\src\services\jimeng-local-media.ts'))
if (!$target.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '目标不在指定项目内，未修改。' }
if (!(Test-Path -LiteralPath $target -PathType Leaf)) { throw '没有找到源码文件。此补丁用于源码部署，不能直接修改已打包 EXE。' }
$current = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
if ($current -eq $manifest.patchedSha256) { Write-Host '此文件已经修复，无需重复应用。'; exit 0 }
if ($current -notin $manifest.acceptedOriginalSha256) { throw '该文件与已核对版本不同，未覆盖。请保留现场，让开发者合并这处修复。' }
Write-Host '请先确认已正常停止这份火宝服务；脚本不会停止进程、删除素材或提交任务。'
$stamp = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8)
$backup = [IO.Path]::GetFullPath((Join-Path $root ('data\local-runtime\backups\snapshot-atomic-' + $stamp)))
if (!$backup.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '备份路径异常，未修改。' }
New-Item -ItemType Directory -Path $backup -Force | Out-Null
Copy-Item -LiteralPath $target -Destination (Join-Path $backup 'jimeng-local-media.ts')
$payload = Join-Path $PSScriptRoot 'backend\src\services\jimeng-local-media.ts'
if ((Get-FileHash -LiteralPath $payload -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.patchedSha256) { throw '补丁文件校验失败，未修改原源码。' }
$temporary = $target + '.patch-' + [guid]::NewGuid().ToString('N') + '.tmp'
try {
    Copy-Item -LiteralPath $payload -Destination $temporary
    Move-Item -LiteralPath $temporary -Destination $target -Force
} finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
}
$receipt = @{ appliedAt = (Get-Date).ToString('o'); originalSha256 = $current; patchedSha256 = $manifest.patchedSha256; relativePath = 'backend/src/services/jimeng-local-media.ts'; modelRequests = 0 }
$receipt | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backup 'APPLIED.json') -Encoding UTF8
Write-Host ('补丁已应用，原文件备份：' + $backup)
Write-Host '现在正常启动火宝。生成中的原任务保留，只手动重试报快照错误的分镜，不要全部重新生成。'
