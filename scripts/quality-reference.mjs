#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cargoTargetDir } from "./cargo-target-dir.mjs";

const fixturePath = fileURLToPath(new URL("./quality-reference-fixture.json", import.meta.url));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function verifyFixture(fixture) {
  if (fixture.schemaVersion !== 1 || !fixture.referenceTool || fixture.entries?.length !== 1) {
    throw new Error("unsupported or empty pinned reference manifest");
  }
  const archive = Buffer.from(fixture.archiveBase64, "base64");
  if (sha256(archive) !== fixture.archiveSha256) throw new Error("pinned archive hash mismatch");
  for (const entry of fixture.entries) {
    if (entry.path !== "payload.bin" || entry.size !== 8193)
      throw new Error("unexpected reference entry");
    const input = Buffer.alloc(entry.size);
    for (let i = 0; i < input.length; i += 1) input[i] = (i * 13 + (i >> 8)) & 255;
    if (sha256(input) !== entry.sha256) throw new Error("pinned input hash mismatch");
  }
  return archive;
}

export function verifyOutput(directory, fixture) {
  for (const entry of fixture.entries) {
    const output = join(directory, entry.path);
    if (!existsSync(output)) throw new Error(`reference extraction missing: ${entry.path}`);
    const bytes = readFileSync(output);
    if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) {
      throw new Error(
        `pinned reference mismatch: ${entry.path}; size expected=${entry.size} actual=${bytes.length}; sha256 expected=${entry.sha256} actual=${sha256(bytes)}`,
      );
    }
  }
}

export function runReference({
  root = process.cwd(),
  binary,
  fixture = JSON.parse(readFileSync(fixturePath, "utf8")),
  execute = spawnSync,
} = {}) {
  const archive = verifyFixture(fixture);
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  const parent = join(cache, "agents/scratch/quality-reference");
  mkdirSync(parent, { recursive: true });
  const scratch = mkdtempSync(join(parent, "run-"));
  try {
    const input = join(scratch, "reference.zip");
    const output = join(scratch, "output");
    writeFileSync(input, archive);
    const cli =
      binary ||
      join(
        cargoTargetDir(root),
        "debug",
        process.platform === "win32" ? "rom-weaver.exe" : "rom-weaver",
      );
    const result = execute(cli, ["extract", "--input", input, "--output", output, "--json"], {
      cwd: root,
      encoding: "utf8",
      timeout: 120000,
    });
    if (result.error || result.status !== 0) {
      throw new Error(
        `reference CLI failed: ${result.error?.message || result.stderr || `exit ${result.status}`}`,
      );
    }
    verifyOutput(output, fixture);
    return {
      signal: "pinned reference",
      status: "passed",
      referenceTool: fixture.referenceTool,
      archiveSha256: fixture.archiveSha256,
      entries: fixture.entries,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(
      JSON.stringify(runReference({ binary: process.env.QUALITY_REFERENCE_BIN }), null, 2),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
