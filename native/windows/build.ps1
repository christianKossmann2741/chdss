[CmdletBinding()]
param([string]$Configuration = "Release", [string]$BuildDirectory = "")
$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
if (!$BuildDirectory) { $BuildDirectory = Join-Path $PSScriptRoot "build-vs" }
try {
  if (!(Get-Command cmake -ErrorAction SilentlyContinue)) { throw "Install Visual Studio 2022 Build Tools with Desktop development with C++ and CMake. Target runtime needs no installation." }
  & cmake -S $PSScriptRoot -B $BuildDirectory -G "Visual Studio 17 2022" -A x64
  if ($LASTEXITCODE -ne 0) { throw "CMake configure failed ($LASTEXITCODE)" }
  & cmake --build $BuildDirectory --config $Configuration --parallel
  if ($LASTEXITCODE -ne 0) { throw "CMake build failed ($LASTEXITCODE)" }
  $bin = Join-Path $repo "native/bin/win32-x64"
  & (Join-Path $bin "policy-tests.exe")
  if ($LASTEXITCODE -ne 0) { throw "Native policy tests failed ($LASTEXITCODE)" }
  & ctest --test-dir $BuildDirectory -C $Configuration --output-on-failure --output-junit (Join-Path $BuildDirectory "policy-tests.xml")
  if ($LASTEXITCODE -ne 0) { throw "CTest failed ($LASTEXITCODE)" }
  $artifact = Get-Item (Join-Path $bin "chdss-audio.exe")
  @{ type = "build-result"; success = $true; architecture = "x64"; runtime = "static"; path = $artifact.FullName; bytes = $artifact.Length; sha256 = (Get-FileHash $artifact.FullName -Algorithm SHA256).Hash; policyTests = "passed"; nativeAudioIsolation = "not-run" } | ConvertTo-Json -Compress
  exit 0
} catch {
  @{ type = "build-result"; success = $false; message = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
