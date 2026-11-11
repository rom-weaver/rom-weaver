#Requires -Version 7
# Zip one prepared Windows platform package for winget, which installs only
# .zip archives and runs no install script. The zip keeps the package layout,
# so the identify data stays at bin\..\share, where the binary looks for it.
param(
  [Parameter(Mandatory)] [string] $Package,
  [Parameter(Mandatory)] [string] $Destination
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$packageRoot = Join-Path $PSScriptRoot "../../packages/rom-weaver-cli-platforms/$Package"
$destinationPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Destination)

Push-Location $packageRoot
try {
  Compress-Archive -LiteralPath bin, share, LICENSE, CLI_NOTICE, third_party -DestinationPath $destinationPath -Force
} finally {
  Pop-Location
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($destinationPath)
try {
  $entries = $zip.Entries.FullName -replace '\\', '/'
} finally {
  $zip.Dispose()
}
foreach ($required in 'bin/rom-weaver.exe', 'share/rom-weaver/identify/v1/catalog.json') {
  if ($entries -notcontains $required) {
    Remove-Item -LiteralPath $destinationPath
    throw "$destinationPath is missing $required"
  }
}
Write-Output "Packaged $destinationPath ($($entries.Count) entries)"
