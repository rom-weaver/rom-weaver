#Requires -Version 5.1
# Windows counterpart to install.sh. Downloads the released rom-weaver binary,
# verifies its published checksum, and drops it in a per-user directory.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = 'rom-weaver/rom-weaver'
$version = if ($env:ROM_WEAVER_VERSION) { $env:ROM_WEAVER_VERSION } else { 'latest' }
$installDir = if ($env:ROM_WEAVER_INSTALL_DIR) {
  $env:ROM_WEAVER_INSTALL_DIR
} else {
  Join-Path $env:LOCALAPPDATA 'rom-weaver\bin'
}

$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
$platformArchitecture = switch ($architecture) {
  ([System.Runtime.InteropServices.Architecture]::Arm64) { 'arm64'; break }
  ([System.Runtime.InteropServices.Architecture]::X64) { 'x64'; break }
  ([System.Runtime.InteropServices.Architecture]::X86) { 'ia32'; break }
  default { throw "rom-weaver does not support Windows/$architecture" }
}

$asset = "rom-weaver-win32-$platformArchitecture-msvc.exe"
$releaseUrl = if ($version -eq 'latest') {
  "https://github.com/$repo/releases/latest/download"
} else {
  "https://github.com/$repo/releases/download/v$($version.TrimStart('v'))"
}

# TLS 1.2 is not the Windows PowerShell 5.1 default and github.com refuses
# anything older. PowerShell 7 negotiates it already and ignores this setting.
if ($PSVersionTable.PSEdition -eq 'Desktop') {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $tempDir | Out-Null
try {
  $binaryPath = Join-Path $tempDir $asset
  $checksumPath = "$binaryPath.sha256"
  # Invoke-WebRequest's progress bar makes the download an order of magnitude
  # slower in Windows PowerShell.
  $previousProgress = $ProgressPreference
  $ProgressPreference = 'SilentlyContinue'
  try {
    Invoke-WebRequest -Uri "$releaseUrl/$asset" -OutFile $binaryPath -UseBasicParsing
    Invoke-WebRequest -Uri "$releaseUrl/$asset.sha256" -OutFile $checksumPath -UseBasicParsing
  } finally {
    $ProgressPreference = $previousProgress
  }

  $expected = (Get-Content -Path $checksumPath -Raw) -replace '(?s)^\s*([0-9a-fA-F]{64}).*$', '$1'
  $actual = (Get-FileHash -Path $binaryPath -Algorithm SHA256).Hash
  if ($expected -ne $actual) {
    throw "checksum mismatch for ${asset}: expected $expected, got $actual"
  }

  New-Item -ItemType Directory -Path $installDir -Force | Out-Null
  $target = Join-Path $installDir 'rom-weaver.exe'
  Move-Item -Path $binaryPath -Destination $target -Force
  Write-Host "Installed rom-weaver to $target"
} finally {
  Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (@($userPath -split ';') -contains $installDir) {
  Write-Host 'Run: rom-weaver --help'
} else {
  Write-Host 'Add rom-weaver to PATH:'
  Write-Host "  [Environment]::SetEnvironmentVariable('Path', `"$installDir;`" + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User')"
  Write-Host 'Then open a new terminal and run: rom-weaver --help'
}
