# Nexus showcase launcher (Windows PowerShell 5.1+).
#
#   powershell -ExecutionPolicy Bypass -File tools\showcase.ps1            # fresh demo project + open the app
#   powershell -ExecutionPolicy Bypass -File tools\showcase.ps1 -Build     # rebuild the app first (needed after code changes)
#   powershell -ExecutionPolicy Bypass -File tools\showcase.ps1 -Fixture node-test-app
#   powershell -ExecutionPolicy Bypass -File tools\showcase.ps1 -Clean     # close the demo app and delete the demo folder
#
# What it does: makes sure Docker is running, creates a SCRATCH data folder and a tiny git project (your real Nexus data and
# projects are never touched: the app is started with --user-data-dir), then opens the real app with the execution and agent
# features switched on. It starts no agent turn by itself: the person showing the demo does that in the app (docs/SHOWCASE.md).
param(
  [string]$Root = (Join-Path $env:USERPROFILE 'nexus-showcase-live'),
  [ValidateSet('pytest-app', 'node-test-app')][string]$Fixture = 'pytest-app',
  [switch]$Build,
  [switch]$Clean
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$user = Join-Path $Root 'userdata'
$project = Join-Path $Root 'demo-project'
$realData = Join-Path $env:APPDATA 'munder-difflin'

function Stop-DemoApp {
  # Only app processes started on THIS scratch folder (matched by their command line), never anything else.
  Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine -like "*$user*" } |
    ForEach-Object { & taskkill /T /F /PID $_.ProcessId | Out-Null }
}

if ($user.TrimEnd('\') -like "$realData*") { throw "Refusing to use the real Nexus data folder ($realData) as the demo folder." }

if ($Clean) {
  Stop-DemoApp
  if (Test-Path $Root) { Remove-Item -LiteralPath $Root -Recurse -Force }
  Write-Host "Demo app closed and $Root deleted."
  return
}

# 1. Docker (the agent's tests run in a sandbox container).
& docker version --format '{{.Server.Os}}' 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Starting Docker Desktop (this takes about a minute)...'
  Start-Process 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
  $ready = $false
  for ($i = 0; $i -lt 30 -and -not $ready; $i++) { Start-Sleep 10; $ready = ((& docker version --format '{{.Server.Os}}' 2>$null) -eq 'linux') }
  if (-not $ready) { throw 'Docker did not become ready. Start Docker Desktop and run this again.' }
}

# 2. Free disk (the execution tests and sandboxes need room; the app checks too).
$free = (Get-PSDrive -Name ($env:SystemDrive.TrimEnd(':'))).Free / 1GB
if ($free -lt 30) { Write-Warning ("Only {0:N1} GiB free on {1}. Nexus execution wants 30 GiB; free some space or the setup sheet will say it cannot run." -f $free, $env:SystemDrive) }

# 3. A fresh scratch project and data folder.
Stop-DemoApp
if (Test-Path $Root) { Remove-Item -LiteralPath $Root -Recurse -Force }
New-Item -ItemType Directory -Path $user, $project | Out-Null
Copy-Item -Path (Join-Path $repo "test\fixtures\exec\$Fixture\*") -Destination $project -Recurse -Force
Push-Location $project
try {
  & git init -q -b main
  & git config core.autocrlf false
  & git config user.email 'demo@example.invalid'
  & git config user.name 'Nexus Demo'
  & git add -A
  & git commit -q -m 'Starting point: a tiny project with a couple of tests'
} finally { Pop-Location }

# 4. The app (build first on request; `out\` must exist).
if ($Build -or -not (Test-Path (Join-Path $repo 'out\main\index.js'))) {
  Write-Host 'Building the app (a few minutes)...'
  Push-Location $repo; try { & npm run build } finally { Pop-Location }
}
$env:NEXUS_ENABLE_V9 = '1'
$env:NEXUS_ENABLE_V10 = '1'
Remove-Item Env:NEXUS_DB_HOLD_V9, Env:NEXUS_DB_HOLD_V10, Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Start-Process -FilePath (Join-Path $repo 'node_modules\electron\dist\electron.exe') -ArgumentList '.', "--user-data-dir=$user" -WorkingDirectory $repo

Write-Host ''
Write-Host 'The Nexus app is opening on a scratch data folder.'
Write-Host "  Demo project folder (pick it when the app asks): $project"
Write-Host '  Follow docs\SHOWCASE.md for the exact clicks and the prompt to paste.'
Write-Host "  When you are done:  powershell -ExecutionPolicy Bypass -File tools\showcase.ps1 -Clean"
