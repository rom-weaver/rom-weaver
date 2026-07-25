import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const asset = `rom-weaver-win32-${packageArchitecture}-msvc.exe`;

// Invoke-WebRequest is stubbed by declaring a function of the same name in the
// caller's scope: PowerShell resolves functions before cmdlets, and install.ps1
// runs in a child scope that inherits it. The checksum is computed from the
// binary the stub just wrote, so the script's own verification is exercised
// rather than bypassed.
const harness = (installDirectory, urlLog) => `
$env:ROM_WEAVER_INSTALL_DIR = '${installDirectory}'
# This test is about the download and its checksum. The provenance branches have
# their own coverage below, and leaving them live here would reach for the real
# gh - which CI runners have - against a stub binary.
$env:ROM_WEAVER_SKIP_ATTESTATION = '1'
function Invoke-WebRequest {
  param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)
  Add-Content -Path '${urlLog}' -Value $Uri
  if ($Uri.EndsWith('.sha256')) {
    $binary = $OutFile -replace '\\.sha256$', ''
    $hash = (Get-FileHash -Path $binary -Algorithm SHA256).Hash
    Set-Content -Path $OutFile -Value "$hash  ${asset}"
  } else {
    Set-Content -Path $OutFile -Value 'binary' -NoNewline
  }
}
& '${resolve("install.ps1")}'
`;

test("installs the checksummed binary", { skip: hasPowerShell ? false : "pwsh not available" }, () => {
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
    assert.ok(output.includes(`Installed rom-weaver to ${target}`));
    assert.deepEqual(readFileSync(urlLog, "utf8").trim().split("\n"), [
      `https://github.com/rom-weaver/rom-weaver/releases/latest/download/${asset}`,
      `https://github.com/rom-weaver/rom-weaver/releases/latest/download/${asset}.sha256`,
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "pins the requested version and rejects a tampered download",
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
  if ($Uri.EndsWith('.sha256')) {
    Set-Content -Path $OutFile -Value "${"a".repeat(64)}  ${asset}"
  } else {
    Set-Content -Path $OutFile -Value 'binary' -NoNewline
  }
}
& '${resolve("install.ps1")}'
`;
      const result = spawnSync(
        "pwsh",
        ["-NoProfile", "-Command", `$env:ROM_WEAVER_INSTALL_DIR = '${join(directory, "install")}'; ${script}`],
        { encoding: "utf8" },
      );

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /checksum mismatch/);
      assert.deepEqual(readFileSync(urlLog, "utf8").trim().split("\n"), [
        `https://github.com/rom-weaver/rom-weaver/releases/download/v9.9.9/${asset}`,
        `https://github.com/rom-weaver/rom-weaver/releases/download/v9.9.9/${asset}.sha256`,
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

// The provenance branches, mirroring scripts/install.test.mjs. `gh` is shadowed
// away rather than stubbed, so these exercise the API fallback - the branch a
// machine without gh takes, and the one PowerShell parses itself.
const PROVENANCE_PREAMBLE = (installDirectory) => `
$env:ROM_WEAVER_INSTALL_DIR = '${installDirectory}'
function Invoke-WebRequest {
  param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)
  if ($Uri.EndsWith('.sha256')) {
    $binary = $OutFile -replace '\\.sha256$', ''
    $hash = (Get-FileHash -Path $binary -Algorithm SHA256).Hash
    Set-Content -Path $OutFile -Value "$hash  ${asset}"
  } else {
    Set-Content -Path $OutFile -Value 'binary' -NoNewline
  }
}
# Reporting gh as absent is what selects the fallback. install.ps1 asks for it
# exactly once, so shadowing the cmdlet affects nothing else.
function Get-Command { param([Parameter(ValueFromRemainingArguments = \$true)]\$Rest) return \$null }
`;

// The statement shape install.ps1 reads, built the way GitHub returns it.
const restStub = (repository) => `
function Invoke-RestMethod {
  param([string]$Uri, [switch]$UseBasicParsing)
  $statement = '{"predicate":{"buildDefinition":{"externalParameters":{"workflow":{"repository":"${repository}"}}}}}'
  $payload = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($statement))
  return (@"
{"attestations":[{"bundle":{"dsseEnvelope":{"payload":"$payload"}}}]}
"@ | ConvertFrom-Json)
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

test("accepts an attestation from this repository", { skip }, () => {
  withPwsh((directory) => {
    const result = runProvenance(directory, restStub("https://github.com/rom-weaver/rom-weaver"));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Found build provenance/);
  });
});

test("refuses an attestation from another repository", { skip }, () => {
  withPwsh((directory) => {
    const result = runProvenance(directory, restStub("https://github.com/someone-else/rom-weaver"));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /did not produce it/);
    // The way out has to be printed, or a refusal is an outage.
    assert.match(result.stderr, /ROM_WEAVER_SKIP_ATTESTATION=1/);
  });
});
