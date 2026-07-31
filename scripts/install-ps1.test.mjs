import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const hasPowerShell = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0;
const runtimeArchitecture = hasPowerShell
  ? execFileSync("pwsh", [
      "-NoProfile",
      "-Command",
      "[System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()",
    ])
      .toString()
      .trim()
  : "x64";
const packageArchitecture = runtimeArchitecture === "x86" ? "ia32" : runtimeArchitecture;
const asset = `rom-weaver-win32-${packageArchitecture}-msvc.tar.gz`;

// Invoke-WebRequest is stubbed by declaring a function of the same name in the
// caller's scope: PowerShell resolves functions before cmdlets, and install.ps1
// runs in a child scope that inherits it.
const harness = (installDirectory, urlLog) => `
$env:ROM_WEAVER_INSTALL_DIR = '${installDirectory}'
# This test is about the download itself. The provenance branches have their own
# coverage below, and leaving them live here would reach the real API for a hash
# nothing has ever attested.
$env:ROM_WEAVER_SKIP_ATTESTATION = '1'
function Invoke-WebRequest {
  param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)
  Add-Content -Path '${urlLog}' -Value $Uri
  if ($Uri -like '*cli-assets.zip') {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::Open($OutFile, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
      $entry = $archive.CreateEntry('completions/rom-weaver.ps1')
      $writer = [System.IO.StreamWriter]::new($entry.Open())
      try { $writer.Write('completion') } finally { $writer.Dispose() }
    } finally {
      $archive.Dispose()
    }
  } elseif ($Uri -like '*.tar.gz') {
    $stage = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
    New-Item -ItemType Directory -Path $stage | Out-Null
    Set-Content -Path (Join-Path $stage 'rom-weaver.exe') -Value 'binary' -NoNewline
    & tar --create --gzip --file $OutFile --directory $stage 'rom-weaver.exe'
    Remove-Item -Recurse -Force $stage
  } else {
    Set-Content -Path $OutFile -Value 'binary' -NoNewline
  }
}
& '${resolve("install.ps1")}'
`;

test("installs the binary", { skip: hasPowerShell ? false : "pwsh not available" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "rom-weaver-install-ps1-"));
  try {
    const installDirectory = join(directory, "install");
    const urlLog = join(directory, "urls.log");
    const output = execFileSync(
      "pwsh",
      ["-NoProfile", "-Command", harness(installDirectory, urlLog)],
      { encoding: "utf8" },
    );

    const target = join(installDirectory, "rom-weaver.exe");
    assert.equal(readFileSync(target, "utf8"), "binary");
    assert.equal(readFileSync(join(installDirectory, "completions/rom-weaver.ps1"), "utf8"), "completion");
    assert.ok(output.includes(`Installed rom-weaver to ${target}`));
    assert.deepEqual(readFileSync(urlLog, "utf8").trim().split("\n"), [
      `https://github.com/rom-weaver/rom-weaver/releases/latest/download/${asset}`,
      "https://github.com/rom-weaver/rom-weaver/releases/latest/download/rom-weaver-cli-assets.zip",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// A tampered download used to be caught by the checksum. It is caught by the
// provenance check now: altered bytes hash to something this repository never
// attested, so the API returns nothing for them and the install is refused.
test(
  "pins the requested version and refuses a tampered download",
  { skip: hasPowerShell ? false : "pwsh not available" },
  () => {
    const directory = mkdtempSync(join(tmpdir(), "rom-weaver-install-ps1-"));
    try {
      const urlLog = join(directory, "urls.log");
      const script = `
$env:ROM_WEAVER_VERSION = 'v9.9.9'
function Invoke-WebRequest {
  param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)
  Add-Content -Path '${urlLog}' -Value $Uri
  Set-Content -Path $OutFile -Value 'tampered' -NoNewline
}
function Invoke-RestMethod { return ('{"attestations":[]}' | ConvertFrom-Json) }
`;
      const result = spawnSync(
        "pwsh",
        ["-NoProfile", "-Command", `$env:ROM_WEAVER_INSTALL_DIR = '${join(directory, "install")}'; ${script}\n& '${resolve("install.ps1")}'`],
        { encoding: "utf8" },
      );

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /no build provenance from/);
      assert.deepEqual(readFileSync(urlLog, "utf8").trim().split("\n"), [
        `https://github.com/rom-weaver/rom-weaver/releases/download/v9.9.9/${asset}`,
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

// The provenance branches, mirroring scripts/install.test.mjs.
const PROVENANCE_PREAMBLE = (installDirectory) => `
$env:ROM_WEAVER_INSTALL_DIR = '${installDirectory}'
function Invoke-WebRequest {
  param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)
  if ($Uri -like '*cli-assets.zip') {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::Open($OutFile, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
      $entry = $archive.CreateEntry('completions/rom-weaver.ps1')
      $writer = [System.IO.StreamWriter]::new($entry.Open())
      try { $writer.Write('completion') } finally { $writer.Dispose() }
    } finally {
      $archive.Dispose()
    }
  } elseif ($Uri -like '*.tar.gz') {
    $stage = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
    New-Item -ItemType Directory -Path $stage | Out-Null
    Set-Content -Path (Join-Path $stage 'rom-weaver.exe') -Value 'binary' -NoNewline
    & tar --create --gzip --file $OutFile --directory $stage 'rom-weaver.exe'
    Remove-Item -Recurse -Force $stage
  } else {
    Set-Content -Path $OutFile -Value 'binary' -NoNewline
  }
}
`;

// The endpoint is scoped to this repository and these bytes, so the only thing
// install.ps1 reads out of the response is whether the array has anything in it.
const restStub = (attestations) => `
function Invoke-RestMethod {
  param([string]$Uri, [switch]$UseBasicParsing)
  return ('{"attestations":${attestations}}' | ConvertFrom-Json)
}
`;

const runProvenance = (directory, script) =>
  spawnSync("pwsh", ["-NoProfile", "-Command", `${PROVENANCE_PREAMBLE(join(directory, "install"))}${script}\n& '${resolve("install.ps1")}'`], {
    encoding: "utf8",
  });

const withPwsh = (body) => {
  const directory = mkdtempSync(join(tmpdir(), "rom-weaver-install-ps1-attest-"));
  try {
    body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const skip = hasPowerShell ? false : "pwsh not available";

test("accepts an attestation for these bytes", { skip }, () => {
  withPwsh((directory) => {
    const result = runProvenance(directory, restStub('[{"repository_id":1}]'));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Verified build provenance/);
  });
});

test("refuses when nothing attested these bytes", { skip }, () => {
  withPwsh((directory) => {
    const result = runProvenance(directory, restStub("[]"));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no build provenance from/);
    // The way out has to be printed, or a refusal is an outage.
    assert.match(result.stderr, /ROM_WEAVER_SKIP_ATTESTATION=1/);
  });
});

// A 200 that is not the shape the check asks for is still an answer, and the
// answer is "nothing attested these bytes" - the same verdict install.sh reaches
// by finding no `repository_id`. Reading the property blind would throw under
// `Set-StrictMode` and be caught as an unreachable API, quietly downgrading this
// refusal to a warning.
test("refuses a 200 that is not an attestations response", { skip }, () => {
  withPwsh((directory) => {
    const result = runProvenance(directory, "\nfunction Invoke-RestMethod { return 'a proxy login page' }\n");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no build provenance from/);
  });
});

// The other half of the split: the question went unanswered, so the install
// continues. HttpRequestException is what PowerShell 7 raises for a transport
// failure, and it carries no `Response` at all - reaching for one throws a
// second time from inside the catch, which is what this pins down.
const TRANSPORT_FAILURE_STUB = `
function Invoke-RestMethod {
  throw [System.Net.Http.HttpRequestException]::new('no such host is known')
}
`;

test("warns but installs when the API cannot be reached", { skip }, () => {
  withPwsh((directory) => {
    const result = runProvenance(directory, TRANSPORT_FAILURE_STUB);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 0, result.stderr);
    assert.match(output, /could not reach the attestations API/);
    assert.match(output, /this download is unverified/);
    assert.ok(existsSync(join(directory, "install", "rom-weaver.exe")), "a warning must not block the install");
  });
});

test("refuses an unreachable API under ROM_WEAVER_REQUIRE_ATTESTATION", { skip }, () => {
  withPwsh((directory) => {
    const result = runProvenance(
      directory,
      `$env:ROM_WEAVER_REQUIRE_ATTESTATION = '1'${TRANSPORT_FAILURE_STUB}`,
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ROM_WEAVER_SKIP_ATTESTATION=1/);
    assert.ok(!existsSync(join(directory, "install", "rom-weaver.exe")), "refused install must leave no binary");
  });
});

// A 404 is GitHub answering rather than failing to, so it refuses like an empty
// list. HttpResponseException is PowerShell 7 only; Windows PowerShell raises
// WebException, whose `Response` the same status read handles.
test("refuses a 404 from the attestations API", { skip }, () => {
  withPwsh((directory) => {
    const result = runProvenance(
      directory,
      `
function Invoke-RestMethod {
  $response = [System.Net.Http.HttpResponseMessage]::new(404)
  throw [Microsoft.PowerShell.Commands.HttpResponseException]::new('Not Found', $response)
}
`,
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no build provenance from/);
    assert.match(result.stderr, /ROM_WEAVER_SKIP_ATTESTATION=1/);
  });
});

// Releases up to v0.10.2 shipped a loose executable instead of a tar.gz. The
// installer must fall back to that name so a pinned old version stays
// installable.
test("falls back to the loose binary asset for pre-archive releases", { skip }, () => {
  const directory = mkdtempSync(join(tmpdir(), "rom-weaver-install-ps1-legacy-"));
  try {
    const installDirectory = join(directory, "install");
    const urlLog = join(directory, "urls.log");
    const script = `
$env:ROM_WEAVER_INSTALL_DIR = '${installDirectory}'
$env:ROM_WEAVER_SKIP_ATTESTATION = '1'
function Invoke-WebRequest {
  param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)
  Add-Content -Path '${urlLog}' -Value $Uri
  if ($Uri -like '*cli-assets.zip') {
    throw 'no docs'
  } elseif ($Uri -like '*.tar.gz') {
    throw 'no archive'
  } else {
    Set-Content -Path $OutFile -Value 'binary' -NoNewline
  }
}
& '${resolve("install.ps1")}'
`;
    const result = spawnSync("pwsh", ["-NoProfile", "-Command", script], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    const target = join(installDirectory, "rom-weaver.exe");
    assert.equal(readFileSync(target, "utf8"), "binary");
    const log = readFileSync(urlLog, "utf8").trim().split("\n");
    assert.match(log[0], /rom-weaver-win32-.*-msvc\.tar\.gz$/);
    assert.match(log[1], /rom-weaver-win32-.*-msvc\.exe$/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
