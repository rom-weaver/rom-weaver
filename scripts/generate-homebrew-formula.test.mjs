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
      ["linux-x64-gnu", "c"],
    ]) {
      writeFileSync(
        join(checksums, `rom-weaver-${platform}.sha256`),
        `${digit.repeat(64)}  rom-weaver-${platform}\n`,
      );
    }

    const output = join(directory, "Formula", "rom-weaver.rb");
    execFileSync(process.execPath, [
      "scripts/generate-homebrew-formula.mjs",
      "1.2.3",
      checksums,
      output,
    ]);
    const formula = readFileSync(output, "utf8");
    assert.match(formula, /version "1\.2\.3"/);
    assert.match(formula, /releases\/download\/v1\.2\.3\/rom-weaver-darwin-arm64/);
    assert.match(formula, /releases\/download\/v1\.2\.3\/rom-weaver-darwin-x64/);
    assert.match(formula, /releases\/download\/v1\.2\.3\/rom-weaver-linux-x64-gnu/);
    assert.match(formula, new RegExp(`sha256 "${"a".repeat(64)}"`));
    assert.match(formula, new RegExp(`sha256 "${"b".repeat(64)}"`));
    assert.match(formula, new RegExp(`sha256 "${"c".repeat(64)}"`));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
