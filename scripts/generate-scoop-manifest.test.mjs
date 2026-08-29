import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("generates a manifest from the release checksum", () => {
  const directory = mkdtempSync(join(tmpdir(), "rom-weaver-scoop-"));
  try {
    const checksums = join(directory, "checksums");
    mkdirSync(checksums);
    const platforms = [
      ["64bit", "win32-x64-msvc", "a"],
      ["32bit", "win32-ia32-msvc", "b"],
      ["arm64", "win32-arm64-msvc", "c"],
    ];
    for (const [, platform, digit] of platforms) {
      const asset = `rom-weaver-${platform}.tar.gz`;
      writeFileSync(join(checksums, `${asset}.sha256`), `${digit.repeat(64)}  ${asset}\n`);
    }
    writeFileSync(
      join(checksums, "rom-weaver-identify-data.tar.br.sha256"),
      `${"d".repeat(64)}  rom-weaver-identify-data.tar.br\n`,
    );

    const output = join(directory, "bucket", "rom-weaver.json");
    execFileSync(process.execPath, [
      "scripts/generate-scoop-manifest.mjs",
      "1.2.3",
      checksums,
      output,
    ]);
    const manifest = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(manifest.version, "1.2.3");
    assert.equal(manifest.bin, "rom-weaver.exe");
    assert.deepEqual(manifest.depends, ["brotli"]);
    assert.deepEqual(manifest.installer.script, [
      '$identifyArchive = Join-Path $dir "rom-weaver-identify-data.tar.br"',
      '$identifyTar = Join-Path $dir "rom-weaver-identify-data.tar"',
      "& brotli --decompress --force --output $identifyTar $identifyArchive",
      'if ($LASTEXITCODE -ne 0) { throw "failed to decompress identify data" }',
      "& tar --extract --file $identifyTar --directory $dir",
      'if ($LASTEXITCODE -ne 0) { throw "failed to extract identify data" }',
      "Remove-Item $identifyArchive, $identifyTar -Force",
    ]);
    for (const [architecture, platform, digit] of platforms) {
      const asset = `rom-weaver-${platform}.tar.gz`;
      assert.deepEqual(manifest.architecture[architecture].hash, [
        digit.repeat(64),
        "d".repeat(64),
      ]);
      // Scoop extracts the archive; the stable `rom-weaver.exe` inside it is
      // what `bin` points at, so the URL carries no rename fragment.
      assert.deepEqual(manifest.architecture[architecture].url, [
        `https://github.com/rom-weaver/rom-weaver/releases/download/v1.2.3/${asset}`,
        "https://github.com/rom-weaver/rom-weaver/releases/download/v1.2.3/rom-weaver-identify-data.tar.br",
      ]);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
