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

  # The checksum above only proves the download is intact - the sidecar ships
  # from the same place as the binary. Build provenance is what says which
  # workflow produced the file, so an asset uploaded by a stolen token fails
  # here even though its checksum matches. Same two branches as install.sh -
  # which parses the response by hand, having no ConvertFrom-Json to lean on.
  # Advisory unless ROM_WEAVER_REQUIRE_ATTESTATION=1.
  $requireAttestation = $env:ROM_WEAVER_REQUIRE_ATTESTATION -eq '1'
  function Write-AttestationWarning([string]$message) {
    if ($requireAttestation) { throw $message }
    Write-Warning $message
  }

  if (Get-Command gh -ErrorAction SilentlyContinue) {
    # The only branch that checks the Sigstore signature, certificate chain, and
    # transparency-log inclusion rather than trusting the API response.
    gh attestation verify $binaryPath --repo $repo 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
      Write-Host "Verified build provenance for $asset"
    } else {
      Write-AttestationWarning "build provenance verification FAILED for $asset"
    }
  } else {
    # No gh, so this trusts GitHub's API over TLS rather than the signature -
    # strictly weaker, but the same trust the download already places in
    # github.com, and it still catches an asset no workflow run produced.
    try {
      $response = Invoke-RestMethod -UseBasicParsing `
        -Uri "https://api.github.com/repos/$repo/attestations/sha256:$($actual.ToLower())"
      $payload = $response.attestations[0].bundle.dsseEnvelope.payload
      $statement = [System.Text.Encoding]::UTF8.GetString(
        [System.Convert]::FromBase64String($payload)) | ConvertFrom-Json
      $sourceUri = $statement.predicate.buildDefinition.externalParameters.workflow.repository
      if ($sourceUri -eq "https://github.com/$repo") {
        Write-Host "Found build provenance for $asset (install gh to verify its signature)"
      } else {
        Write-AttestationWarning "no build provenance from $repo for $asset"
      }
    } catch {
      Write-AttestationWarning "no build provenance published for ${asset}: $($_.Exception.Message)"
    }
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
