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
  # Invoke-WebRequest's progress bar makes the download an order of magnitude
  # slower in Windows PowerShell.
  $previousProgress = $ProgressPreference
  $ProgressPreference = 'SilentlyContinue'
  try {
    Invoke-WebRequest -Uri "$releaseUrl/$asset" -OutFile $binaryPath -UseBasicParsing
  } finally {
    $ProgressPreference = $previousProgress
  }

  # Hash what actually arrived - the lookup key for the provenance check, and the
  # reason there is no separate checksum step. See install.sh for the full note.
  $actual = (Get-FileHash -Path $binaryPath -Algorithm SHA256).Hash

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

  # Only an HTTP error carries a response to read a status off. PowerShell 7
  # raises System.Net.Http.HttpRequestException for a transport failure - no
  # `Response` property at all - and under `Set-StrictMode` reaching for one
  # throws a second time, from inside the catch, losing the warn-and-continue
  # this returns 0 to reach. Windows PowerShell's WebException has the property
  # and leaves it null, which the same `-eq 404` handles.
  function Get-StatusCode($exception) {
    if (-not $exception.PSObject.Properties['Response']) { return 0 }
    if ($null -eq $exception.Response) { return 0 }
    return $exception.Response.StatusCode.value__
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
