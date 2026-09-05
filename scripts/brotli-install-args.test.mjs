import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Every install channel decompresses the identify data with the brotli CLI.
// brotli >= 1.2.0 rejects `--output <file>` ("must pass the parameter as
// --output=value") and exits 0 after printing its usage, so the separate
// argument form silently installs no database (v0.14.0 shipped that way, and
// it aborted the Homebrew install outright).
const SOURCES = [
  "install.sh",
  "install.ps1",
  "scripts/generate-scoop-manifest.mjs",
  "scripts/generate-scoop-manifest.test.mjs",
  "scripts/generate-homebrew-formula.mjs",
];

// Joins each brotli invocation with its shell continuation lines, so the
// check reads the whole command and ignores --output flags belonging to curl
// or tar elsewhere in the same file.
function brotliCommands(text) {
  const lines = text.split("\n");
  const commands = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/\bbrotli\b/.test(lines[index])) continue;
    let command = lines[index];
    while (command.trimEnd().endsWith("\\") && index + 1 < lines.length) {
      index += 1;
      command = `${command.trimEnd().slice(0, -1)} ${lines[index].trim()}`;
    }
    commands.push(command);
  }
  return commands;
}

test("install sources pass brotli's --output as a single argument", () => {
  let checked = 0;
  for (const source of SOURCES) {
    for (const command of brotliCommands(readFileSync(source, "utf8"))) {
      if (!command.includes("--output")) continue;
      checked += 1;
      assert.doesNotMatch(
        command,
        /--output["']?[\s,]/,
        `${source}: brotli requires --output=value, got: ${command.trim()}`,
      );
    }
  }
  // A rename that stops matching the sources would otherwise pass silently.
  assert.equal(checked, SOURCES.length);
});

test("the installed brotli accepts --output=value and rejects the split form", (t) => {
  const probe = spawnSync("brotli", ["--version"]);
  if (probe.error) {
    t.skip("brotli is not installed");
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "rom-weaver-brotli-"));
  try {
    const payload = "identify database payload";
    const plain = join(directory, "payload");
    const compressed = join(directory, "payload.br");
    const decompressed = join(directory, "payload.out");
    writeFileSync(plain, payload);
    execFileSync("brotli", ["--force", `--output=${compressed}`, plain]);

    execFileSync("brotli", ["--decompress", "--force", `--output=${decompressed}`, compressed]);
    assert.equal(readFileSync(decompressed, "utf8"), payload);

    // Pins the behaviour the fix exists for: brotli exits 0 here, so callers
    // cannot detect the failure from the exit status alone.
    const split = spawnSync(
      "brotli",
      ["--decompress", "--force", "--output", join(directory, "never"), compressed],
      { encoding: "utf8" },
    );
    assert.match(split.stderr, /must pass the parameter as --output=value/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
