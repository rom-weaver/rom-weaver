#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const runtimeDirectory = path.resolve(process.argv[2] ?? "");
assert.ok(process.argv[2], "usage: verify-runtime.mjs RUNTIME_DIRECTORY");

const manifestPath = path.join(runtimeDirectory, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const exactKeys = (value, expected, label) => {
  assert.deepEqual(
    Object.keys(value).sort(),
    [...expected].sort(),
    `${label} has unexpected fields`,
  );
};
const digest = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const resolveFile = (relativePath, executable = false) => {
  assert.equal(
    relativePath,
    path.posix.normalize(relativePath),
    `${relativePath} is not normalized`,
  );
  assert.ok(!path.posix.isAbsolute(relativePath), `${relativePath} must be relative`);
  assert.ok(
    relativePath !== ".." && !relativePath.startsWith("../"),
    `${relativePath} escapes the runtime`,
  );
  const file = path.resolve(runtimeDirectory, relativePath);
  assert.ok(
    file.startsWith(`${runtimeDirectory}${path.sep}`),
    `${relativePath} escapes the runtime`,
  );
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile(), `${relativePath} must be a regular file`);
  assert.ok(!stat.isSymbolicLink(), `${relativePath} must not be a symbolic link`);
  if (executable) assert.ok(stat.mode & 0o111, `${relativePath} must be executable`);
  return file;
};

exactKeys(manifest, ["schemaVersion", "platform", "retroarch", "cores"], "manifest");
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.platform, "linux-x64-gnu");
exactKeys(manifest.retroarch, ["path", "revision", "sha256"], "retroarch");
assert.match(manifest.retroarch.revision, /^[0-9a-f]{40}$/);
assert.match(manifest.retroarch.sha256, /^[0-9a-f]{64}$/);
assert.equal(digest(resolveFile(manifest.retroarch.path, true)), manifest.retroarch.sha256);
assert.equal(manifest.cores.length, 1);

const [core] = manifest.cores;
exactKeys(core, ["id", "platform", "path", "revision", "sha256"], "core");
assert.equal(core.id, "fceumm");
assert.equal(core.platform, "nes");
assert.match(core.revision, /^[0-9a-f]{40}$/);
assert.match(core.sha256, /^[0-9a-f]{64}$/);
assert.equal(digest(resolveFile(core.path)), core.sha256);

resolveFile("licenses/RetroArch-COPYING");
resolveFile("licenses/FCEUmm-Copying");
console.log(`verified emulator runtime: ${runtimeDirectory}`);
