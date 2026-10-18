# Starts the production build of the calculator locally and opens it in the browser.
# Rebuilds first if the source has changed since the last build (or with -Rebuild).
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts\start-prod.ps1 [-Rebuild] [-Port 3123]
param(
  [switch]$Rebuild,
  [int]$Port = 3123
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$Host.UI.RawUI.WindowTitle = 'OSRS DPS calculator'

# Node may not be on PATH in shells started before it was installed
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  $env:Path = "C:\Program Files\nodejs;$env:Path"
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js was not found. Install it with: winget install OpenJS.NodeJS.LTS' -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}

$url = "http://localhost:$Port/osrs-dps/"

# If it's already running, just open it
$client = New-Object System.Net.Sockets.TcpClient
try {
  $client.Connect('127.0.0.1', $Port)
  $client.Close()
  Write-Host "Already running, opening $url"
  Start-Process $url
  exit 0
} catch {
  $client.Dispose()
}

$yarn = Join-Path $repo '.yarn\releases\yarn-4.9.2.cjs'

if (-not (Test-Path 'node_modules')) {
  Write-Host 'Installing dependencies...' -ForegroundColor Cyan
  node $yarn install
  if ($LASTEXITCODE -ne 0) { Read-Host 'Install failed. Press Enter to close'; exit 1 }
}

# Rebuild if there is no build yet, or anything that affects it is newer than the build
$buildMarker = Join-Path $repo 'out\index.html'
$needsBuild = $Rebuild -or -not (Test-Path $buildMarker)
if (-not $needsBuild) {
  $builtAt = (Get-Item $buildMarker).LastWriteTime
  $inputs = @(Get-ChildItem -Recurse -File 'src', 'cdn\json') + @(Get-Item 'package.json', 'next.config.js', '.env.production')
  $newest = ($inputs | Measure-Object -Property LastWriteTime -Maximum).Maximum
  $needsBuild = $newest -gt $builtAt
}

if ($needsBuild) {
  Write-Host 'Building the production version (this takes a minute or two)...' -ForegroundColor Cyan
  node $yarn build
  if ($LASTEXITCODE -ne 0) { Read-Host 'Build failed. Press Enter to close'; exit 1 }
} else {
  Write-Host 'Build is up to date.'
}

# Open the browser once the server has had a moment to start
Start-Job -ScriptBlock { param($u) Start-Sleep -Seconds 1; Start-Process $u } -ArgumentList $url | Out-Null

$env:PORT = "$Port"
node (Join-Path $repo 'scripts\serve-prod.mjs')
if ($LASTEXITCODE -ne 0) { Read-Host 'Server stopped with an error. Press Enter to close' }
