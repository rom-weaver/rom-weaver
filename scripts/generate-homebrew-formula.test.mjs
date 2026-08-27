import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("generates a formula from release checksums", () => {
  const directory = mkdtempSync(join(tmpdir(), "rom-weaver-homebrew-"));
  try {
    const checksums = join(directory, "checksums");
    mkdirSync(checksums);
    for (const [platform, digit] of [
      ["darwin-arm64", "a"],
      ["darwin-x64", "b"],
      ["linux-arm64-musl", "c"],
      ["linux-x64-gnu", "d"],
    ]) {
      writeFileSync(
        join(checksums, `rom-weaver-${platform}.tar.gz.sha256`),
        `${digit.repeat(64)}  rom-weaver-${platform}.tar.gz\n`,
      );
    }
    writeFileSync(
      join(checksums, "rom-weaver-cli-assets.tar.gz.sha256"),
      `${"e".repeat(64)}  rom-weaver-cli-assets.tar.gz\n`,
    );
    writeFileSync(
      join(checksums, "rom-weaver-identify-data.tar.zst.sha256"),
      `${"f".repeat(64)}  rom-weaver-identify-data.tar.zst\n`,
    );

    const output = join(directory, "Formula", "rom-weaver.rb");
    execFileSync(process.execPath, [
      "scripts/generate-homebrew-formula.mjs",
      "1.2.3",
      checksums,
      output,
    ]);
    const formula = readFileSync(output, "utf8");
    assert.match(formula, /version "1\.2\.3"/);
    assert.match(formula, /releases\/download\/v1\.2\.3\/rom-weaver-darwin-arm64\.tar\.gz/);
    assert.match(formula, /releases\/download\/v1\.2\.3\/rom-weaver-darwin-x64\.tar\.gz/);
    assert.match(formula, /releases\/download\/v1\.2\.3\/rom-weaver-linux-arm64-musl\.tar\.gz/);
    assert.match(formula, /releases\/download\/v1\.2\.3\/rom-weaver-linux-x64-gnu\.tar\.gz/);
    assert.match(formula, new RegExp(`sha256 "${"a".repeat(64)}"`));
    assert.match(formula, new RegExp(`sha256 "${"b".repeat(64)}"`));
    assert.match(formula, new RegExp(`sha256 "${"c".repeat(64)}"`));
    assert.match(formula, new RegExp(`sha256 "${"d".repeat(64)}"`));
    assert.match(formula, /rom-weaver-cli-assets\.tar\.gz/);
    assert.match(formula, new RegExp(`sha256 "${"e".repeat(64)}"`));
    assert.match(formula, /rom-weaver-identify-data\.tar\.zst/);
    assert.match(formula, new RegExp(`sha256 "${"f".repeat(64)}"`));
    assert.match(formula, /share\.install "share\/rom-weaver"/);
    assert.match(formula, /bin\.install "rom-weaver"/);
    assert.match(formula, /bash_completion\.install/);
    assert.match(formula, /zsh_completion\.install/);
    assert.match(formula, /fish_completion\.install/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
