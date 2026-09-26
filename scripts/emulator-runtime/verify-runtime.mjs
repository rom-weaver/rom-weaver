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
  assert.ok(!relativePath.includes("\\"), `${relativePath} must not contain backslashes`);
  const file = path.resolve(runtimeDirectory, relativePath);
  assert.ok(
    file.startsWith(`${runtimeDirectory}${path.sep}`),
    `${relativePath} escapes the runtime`,
  );
  let prefix = runtimeDirectory;
  for (const component of relativePath.split("/")) {
    prefix = path.join(prefix, component);
    assert.ok(
      !fs.lstatSync(prefix).isSymbolicLink(),
      `${relativePath} must not contain symbolic links`,
    );
  }
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile(), `${relativePath} must be a regular file`);
  assert.ok(!stat.isSymbolicLink(), `${relativePath} must not be a symbolic link`);
  if (executable) assert.ok(stat.mode & 0o111, `${relativePath} must be executable`);
  return file;
};

assert.ok([1, 2].includes(manifest.schemaVersion));
exactKeys(
  manifest,
  manifest.schemaVersion === 2
    ? ["schemaVersion", "platform", "retroarch", "cores", "systemFiles"]
    : ["schemaVersion", "platform", "retroarch", "cores"],
  "manifest",
);
assert.equal(manifest.platform, "linux-x64-gnu");
exactKeys(manifest.retroarch, ["path", "revision", "sha256"], "retroarch");
assert.equal(manifest.retroarch.path, "bin/retroarch");
assert.match(manifest.retroarch.revision, /^[0-9a-f]{40}$/);
assert.match(manifest.retroarch.sha256, /^[0-9a-f]{64}$/);
assert.equal(digest(resolveFile(manifest.retroarch.path, true)), manifest.retroarch.sha256);
assert.ok(manifest.cores.length > 0 && manifest.cores.length <= 256);
const ids = new Set();
for (const core of manifest.cores) {
  exactKeys(
    core,
    manifest.schemaVersion === 2
      ? ["id", "platform", "path", "revision", "sha256", "extensions", "options", "firmware"]
      : ["id", "platform", "path", "revision", "sha256"],
    "core",
  );
  assert.match(core.id, /^[a-z0-9_-]{1,64}$/);
  assert.ok(!ids.has(core.id), `duplicate core: ${core.id}`);
  ids.add(core.id);
  assert.match(core.platform, /^[a-z0-9_-]{1,64}$/);
  assert.equal(core.path, `cores/${core.id}_libretro.so`);
  assert.match(core.revision, /^[0-9a-f]{40}$/);
  assert.match(core.sha256, /^[0-9a-f]{64}$/);
  assert.equal(digest(resolveFile(core.path)), core.sha256);
  assert.ok((core.extensions ?? []).length <= 128);
  assert.ok(Object.keys(core.options ?? {}).length <= 128);
  assert.ok((core.firmware ?? []).length <= 64);
  for (const extension of core.extensions ?? []) assert.match(extension, /^[a-z0-9]{1,16}$/);
  for (const [key, value] of Object.entries(core.options ?? {})) {
    assert.match(key, /^[a-z0-9_-]{1,64}$/);
    assert.equal(typeof value, "string");
    assert.ok(
      value.length <= 256 &&
        [...value].every((character) => {
          const code = character.codePointAt(0);
          return (
            code >= 32 && !(code >= 127 && code <= 159) && character !== '"' && character !== "\\"
          );
        }),
      `invalid option: ${key}`,
    );
  }
  for (const filename of core.firmware ?? []) {
    assert.ok(
      filename &&
        !filename.includes("\\") &&
        filename.split("/").every((part) => part && part !== "." && part !== ".."),
      "unsafe firmware path",
    );
  }
}
assert.ok((manifest.systemFiles ?? []).length <= 4096);
const systemPaths = new Set();
for (const asset of manifest.systemFiles ?? []) {
  exactKeys(asset, ["path", "sha256"], "system asset");
  assert.ok(asset.path.startsWith("system/") && !systemPaths.has(asset.path));
  systemPaths.add(asset.path);
  assert.match(asset.sha256, /^[0-9a-f]{64}$/);
  assert.equal(digest(resolveFile(asset.path)), asset.sha256);
}

resolveFile("licenses/RetroArch-COPYING");
resolveFile("licenses/FCEUmm-Copying");
console.log(`verified emulator runtime: ${runtimeDirectory}`);
