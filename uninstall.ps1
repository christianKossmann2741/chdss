param(
  [string]$InstallDir = "$env:LOCALAPPDATA\CHDSS",
  [string]$BinDir = "$env:LOCALAPPDATA\CHDSS-command"
)
$ErrorActionPreference = 'Stop'
if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
if (Test-Path $BinDir) { Remove-Item $BinDir -Recurse -Force }
$userPath = [Environment]::GetEnvironmentVariable('Path', [EnvironmentVariableTarget]::User)
$clean = @($userPath -split ';' | Where-Object { $_ -and $_ -ne $BinDir }) -join ';'
[Environment]::SetEnvironmentVariable('Path', $clean, [EnvironmentVariableTarget]::User)
Write-Host 'CHDSS has been removed. Open a new terminal to refresh PATH.'
