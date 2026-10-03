param(
  [string]$InstallDir = "$env:LOCALAPPDATA\CHDSS",
  [string]$BinDir = "$env:LOCALAPPDATA\CHDSS-command"
)
$ErrorActionPreference = 'Stop'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'CHDSS requires Node.js 20+ (https://nodejs.org).' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'CHDSS requires npm.' }
$major = [int]((node --version).TrimStart('v').Split('.')[0])
if ($major -lt 20) { throw 'CHDSS requires Node.js 20 or newer.' }

$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$stage = Join-Path $env:TEMP ("chdss-install-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  @('package.json','package-lock.json','src','public','bin','scripts','native','test','LICENSE','README.md','uninstall.ps1') | ForEach-Object {
    $item = Join-Path $source $_
    if (Test-Path $item) { Copy-Item $item $stage -Recurse -Force }
  }
  Push-Location $stage
  try {
    & npm.cmd ci --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
    & npm.cmd run build:web; if ($LASTEXITCODE -ne 0) { throw 'Browser SDK build failed.' }
    & node scripts/build-native.js; if ($LASTEXITCODE -ne 0) { throw 'Native audio build failed. Source installs require Visual Studio C++ Build Tools; use the portable download to avoid compiler prerequisites.' }
  }
  finally { Pop-Location }
  if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
  New-Item -ItemType Directory -Path (Split-Path -Parent $InstallDir) -Force | Out-Null
  Move-Item $stage $InstallDir
  New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
  $launcher = "@echo off`r`nnode `"$InstallDir\bin\chdss.js`" %*`r`n"
  Set-Content -Path (Join-Path $BinDir 'chdss.cmd') -Value $launcher -Encoding Ascii

  $userPath = [Environment]::GetEnvironmentVariable('Path', [EnvironmentVariableTarget]::User)
  $parts = @($userPath -split ';' | Where-Object { $_ })
  if ($parts -notcontains $BinDir) {
    [Environment]::SetEnvironmentVariable('Path', (($parts + $BinDir) -join ';'), [EnvironmentVariableTarget]::User)
  }
  Write-Host "Installed Christian's Handy Dandy Screen Share."
  Write-Host "Open a new terminal, then run: chdss"
  Write-Host "Windows may ask for firewall permission; allow Private networks only."
} finally {
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
}
