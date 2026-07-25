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
  Set-Content -Path $OutFile -Value 'binary' -NoNewline
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
    assert.ok(output.includes(`Installed rom-weaver to ${target}`));
    assert.deepEqual(readFileSync(urlLog, "utf8").trim().split("\n"), [
      `https://github.com/rom-weaver/rom-weaver/releases/latest/download/${asset}`,
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
  Set-Content -Path $OutFile -Value 'binary' -NoNewline
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
