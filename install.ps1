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

$asset = "rom-weaver-win32-$platformArchitecture-msvc.tar.gz"
$legacyAsset = "rom-weaver-win32-$platformArchitecture-msvc.exe"
$docsAsset = 'rom-weaver-cli-assets.zip'
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

# Only an HTTP error carries a response to read a status off. PowerShell 7
# raises System.Net.Http.HttpRequestException for a transport failure - no
# `Response` property at all - and under `Set-StrictMode` reaching for one
# throws a second time, from inside the catch, losing the warn-and-continue
# its callers return 0 to reach. Windows PowerShell's WebException has the
# property and leaves it null, which the same `-eq 404` handles.
function Get-StatusCode($exception) {
  if (-not $exception.PSObject.Properties['Response']) { return 0 }
  if ($null -eq $exception.Response) { return 0 }
  return $exception.Response.StatusCode.value__
}

$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $tempDir | Out-Null
try {
  # Invoke-WebRequest's progress bar makes the download an order of magnitude
  # slower in Windows PowerShell.
  $previousProgress = $ProgressPreference
  $ProgressPreference = 'SilentlyContinue'
  try {
    # Releases up to v0.10.2 shipped the executable as a loose file instead of
    # a tar.gz. Fall back only on a definite 404 - the pinned version predates
    # the archive - so a transient failure surfaces as itself instead of as the
    # legacy asset's error.
    try {
      $downloadPath = Join-Path $tempDir $asset
      Invoke-WebRequest -Uri "$releaseUrl/$asset" -OutFile $downloadPath -UseBasicParsing
    } catch {
      if ((Get-StatusCode $_.Exception) -ne 404) { throw }
      $asset = $legacyAsset
      $downloadPath = Join-Path $tempDir $asset
      Invoke-WebRequest -Uri "$releaseUrl/$asset" -OutFile $downloadPath -UseBasicParsing
    }
  } finally {
    $ProgressPreference = $previousProgress
  }

  # Hash what actually arrived - the lookup key for the provenance check, and the
  # reason there is no separate checksum step. See install.sh for the full note.
  $actual = (Get-FileHash -Path $downloadPath -Algorithm SHA256).Hash

  # Build provenance says which workflow produced this file. The endpoint is
  # scoped to this repository and to these exact bytes, so a non-empty answer is
  # the whole finding and nothing has to be read out of it - see install.sh for
  # why decoding the signed bundle would buy appearance rather than assurance.
  $skipAttestation = $env:ROM_WEAVER_SKIP_ATTESTATION -eq '1'
  $requireAttestation = $env:ROM_WEAVER_REQUIRE_ATTESTATION -eq '1'

  # A definite answer refuses, an absent one warns. Every refusal says how to get
  # past it.
  function Deny-Install([string]$message) {
    Write-Error $message -ErrorAction Continue
    throw "refusing to install ${asset}: to install it anyway, re-run with ROM_WEAVER_SKIP_ATTESTATION=1"
  }

  if ($skipAttestation) {
    Write-Warning 'skipping the build provenance check (ROM_WEAVER_SKIP_ATTESTATION=1)'
  } else {
    $attestations = @()
    $answered = $false
    try {
      # predicate_type is load-bearing - see install.sh. Without it, GitHub's
      # automatic immutable-release attestation answers for any release asset.
      $response = Invoke-RestMethod -UseBasicParsing `
        -Uri "https://api.github.com/repos/$repo/attestations/sha256:$($actual.ToLower())?predicate_type=https://slsa.dev/provenance/v1"
      # A 200 carrying anything other than the expected shape - a proxy's login
      # page, say - is still an answer, and the answer is that nothing attested
      # these bytes. Reading the property blind would instead throw under
      # `Set-StrictMode` and land in the catch below, turning a refusal into a
      # warn-and-install. install.sh refuses the same case, by finding no
      # `repository_id` in the body.
      if ($null -ne $response -and $response.PSObject.Properties['attestations']) {
        $attestations = @($response.attestations)
      }
      $answered = $true
    } catch {
      # 404 is GitHub answering "nothing attested these bytes", which is a
      # verdict; anything else (rate limit, 5xx, no network) left the question
      # unanswered.
      if ((Get-StatusCode $_.Exception) -eq 404) {
        Deny-Install "no build provenance from $repo for $asset"
      }
      $message = "could not reach the attestations API for ${asset}: $($_.Exception.Message)"
      if ($requireAttestation) { Deny-Install $message }
      Write-Warning $message
      Write-Warning 'continuing - this download is unverified'
    }

    if ($answered) {
      if ($attestations.Count -gt 0) {
        Write-Host "Verified build provenance for $asset"
      } else {
        Deny-Install "no build provenance from $repo for $asset"
      }
    }
  }

  $docsPath = Join-Path $tempDir $docsAsset
  try {
    Invoke-WebRequest -Uri "$releaseUrl/$docsAsset" -OutFile $docsPath -UseBasicParsing
  } catch {
    Write-Warning 'CLI documentation asset unavailable; installing the binary only'
    $docsPath = $null
  }

  New-Item -ItemType Directory -Path $installDir -Force | Out-Null
  $target = Join-Path $installDir 'rom-weaver.exe'
  if ($asset.EndsWith('.tar.gz')) {
    # tar.exe (bsdtar) ships with Windows 10 1803+, which is older than the
    # PowerShell 5.1 floor above - checked anyway so an older machine gets a
    # sentence instead of a CommandNotFoundException.
    if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
      throw "tar is required to extract $asset and ships with Windows 10 1803+; install tar and re-run"
    }
    & tar --extract --gzip --file $downloadPath --directory $tempDir 'rom-weaver.exe'
    if ($LASTEXITCODE -ne 0) { throw "failed to extract $asset" }
    Move-Item -Path (Join-Path $tempDir 'rom-weaver.exe') -Destination $target -Force
  } else {
    Move-Item -Path $downloadPath -Destination $target -Force
  }
  Write-Host "Installed rom-weaver to $target"
  if ($docsPath) {
    $docsDir = Join-Path $tempDir 'docs'
    Expand-Archive -LiteralPath $docsPath -DestinationPath $docsDir -Force
    $completionDir = Join-Path $installDir 'completions'
    New-Item -ItemType Directory -Path $completionDir -Force | Out-Null
    Copy-Item (Join-Path $docsDir 'completions/rom-weaver.ps1') (Join-Path $completionDir 'rom-weaver.ps1') -Force
    Write-Host "Installed PowerShell completion to $(Join-Path $completionDir 'rom-weaver.ps1')"
  }
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
