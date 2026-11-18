$ErrorActionPreference = 'Stop'
$original = @{ GOOS=$env:GOOS; GOARCH=$env:GOARCH; CGO_ENABLED=$env:CGO_ENABLED }
$go = (Get-Command go.exe -ErrorAction Stop).Source
$targets = @(
 @{key='win32-x64';os='windows';arch='amd64';file='provider-engine-windows-amd64.exe'},
 @{key='linux-x64';os='linux';arch='amd64';file='provider-engine-linux-amd64'},
 @{key='linux-arm64';os='linux';arch='arm64';file='provider-engine-linux-arm64'},
 @{key='darwin-arm64';os='darwin';arch='arm64';file='provider-engine-darwin-arm64'}
)
$binaries=@{}
Push-Location $PSScriptRoot
try {
 New-Item -ItemType Directory -Path (Join-Path $PSScriptRoot 'bin') -Force | Out-Null
 foreach($target in $targets){
  $env:GOOS=$target.os;$env:GOARCH=$target.arch;$env:CGO_ENABLED='0'
  $output=Join-Path $PSScriptRoot ('bin\'+$target.file)
  & $go build -trimpath -ldflags '-s -w' -o $output ./cmd/provider-engine
  if($LASTEXITCODE -ne 0){throw ('Go cross-build failed: '+$target.key)}
  $binaries[$target.key]=@{filename=$target.file;sha256=(Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()}
 }
 $receipt=@{binaries=$binaries;sha256=$binaries['win32-x64'].sha256;goVersion=(& $go version);builtAt=[DateTime]::UtcNow.ToString('o');upstream='ddcat-ai/open-ai-canvas review-20261101'}|ConvertTo-Json -Depth 5
 [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'engine-build.json'),$receipt,[Text.UTF8Encoding]::new($false))
} finally {Pop-Location;$env:GOOS=$original.GOOS;$env:GOARCH=$original.GOARCH;$env:CGO_ENABLED=$original.CGO_ENABLED}
