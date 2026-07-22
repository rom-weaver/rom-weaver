import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { restoreExecutableMode } from "./npm-publish-package.mjs";

test("restores executable mode before publishing binary packages", () => {
  const directory = mkdtempSync(join(tmpdir(), "rom-weaver-npm-publish-"));
  try {
    const binDirectory = join(directory, "bin");
    mkdirSync(binDirectory);
    writeFileSync(join(binDirectory, "rom-weaver"), "binary");
    chmodSync(join(binDirectory, "rom-weaver"), 0o644);

    restoreExecutableMode(directory, { bin: { "rom-weaver": "bin/rom-weaver" } });

    assert.equal(statSync(join(binDirectory, "rom-weaver")).mode & 0o777, 0o755);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
