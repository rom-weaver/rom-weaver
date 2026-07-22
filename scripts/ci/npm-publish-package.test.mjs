import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("restores executable mode before publishing binary packages", () => {
  const directory = mkdtempSync(join(tmpdir(), "rom-weaver-npm-publish-"));
  try {
    const binDirectory = join(directory, "bin");
    const fakeNpm = join(directory, "npm");
    mkdirSync(binDirectory);
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ bin: { "rom-weaver": "bin/rom-weaver" }, name: "example", version: "1.0.0" }),
    );
    writeFileSync(join(binDirectory, "rom-weaver"), "binary");
    writeFileSync(fakeNpm, `#!${process.execPath}\nif (process.argv[2] === "view") process.exit(1);\n`);
    chmodSync(fakeNpm, 0o755);

    execFileSync(process.execPath, [resolve("scripts/ci/npm-publish-package.mjs"), directory], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
      stdio: "ignore",
    });

    assert.equal(statSync(join(binDirectory, "rom-weaver")).mode & 0o777, 0o755);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
