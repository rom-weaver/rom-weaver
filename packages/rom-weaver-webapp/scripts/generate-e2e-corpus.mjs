#!/usr/bin/env node

import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PACKAGE_DIR, "..", "..");
const CORPUS_DIR = path.join(REPO_ROOT, "target", "e2e-corpus");
const CLI = path.join(REPO_ROOT, "target", "debug", process.platform === "win32" ? "rom-weaver.exe" : "rom-weaver");
const MIB = 1024 * 1024;
const smoke = process.argv.includes("--smoke");
const localArgIndex = process.argv.indexOf("--local-corpus");
if (localArgIndex >= 0 && !process.argv[localArgIndex + 1]) throw new Error("--local-corpus requires a directory path");
const localCorpus = localArgIndex >= 0 ? path.resolve(process.argv[localArgIndex + 1]) : null;
const sizes = smoke
  ? { budget200: 2 * MIB, budget933: 3 * MIB, highRatio: 2 * MIB, random: 2 * MIB, nested: 2 * MIB }
  : { budget200: 200 * MIB, budget933: 933 * MIB, highRatio: 512 * MIB, random: 256 * MIB, nested: 256 * MIB };

const run = (command, args, label) => {
  process.stdout.write(`${label}\n`);
  const result = childProcess.spawnSync(command, args, { cwd: REPO_ROOT, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} exited with ${result.status}`);
};

const ensureSparseFile = (filePath, size) => {
  if (fs.existsSync(filePath) && fs.statSync(filePath).size === size) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, "w");
  try {
    fs.ftruncateSync(fd, size);
  } finally {
    fs.closeSync(fd);
  }
};

const ensurePseudoRandomFile = (filePath, size) => {
  if (fs.existsSync(filePath) && fs.statSync(filePath).size === size) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, "w");
  const buffer = Buffer.allocUnsafe(MIB);
  let state = 0x6d2b79f5;
  try {
    for (let offset = 0; offset < size; offset += buffer.length) {
      const length = Math.min(buffer.length, size - offset);
      for (let index = 0; index < length; index += 1) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        buffer[index] = state & 0xff;
      }
      fs.writeSync(fd, buffer, 0, length);
    }
  } finally {
    fs.closeSync(fd);
  }
};

const fileSha256 = (filePath) => {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(4 * MIB);
  try {
    while (true) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
};

const ensureArchive = (output, format, inputs) => {
  if (fs.existsSync(output) && fs.statSync(output).size > 0) return;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  run(
    CLI,
    ["compress", ...inputs, "--format", format, "--output", output, "--level", "min", "--threads", "4"],
    `Creating ${path.basename(output)}`,
  );
};

const linkOrCopy = (source, destination) => {
  if (fs.existsSync(destination)) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fs.linkSync(source, destination);
  } catch {
    fs.copyFileSync(source, destination);
  }
};

const main = () => {
  fs.mkdirSync(CORPUS_DIR, { recursive: true });
  const previousManifestPath = path.join(CORPUS_DIR, "manifest.json");
  let previousSmoke = null;
  try {
    previousSmoke = JSON.parse(fs.readFileSync(previousManifestPath, "utf8")).smoke === true;
  } catch {
    // No reusable corpus yet.
  }
  if (previousSmoke !== null && previousSmoke !== smoke) {
    fs.rmSync(path.join(CORPUS_DIR, "files"), { force: true, recursive: true });
    fs.rmSync(path.join(CORPUS_DIR, "sources", "many-entries"), { force: true, recursive: true });
    fs.rmSync(path.join(CORPUS_DIR, "sources", "nested-inner.zip"), { force: true });
    fs.rmSync(path.join(CORPUS_DIR, "sources", "nested-middle.7z"), { force: true });
  }
  run("cargo", ["build", "-p", "rom-weaver-cli"], "Building corpus generator CLI");

  const sources = path.join(CORPUS_DIR, "sources");
  const files = path.join(CORPUS_DIR, "files");
  const zero200 = path.join(sources, "zero-200.bin");
  const zero933 = path.join(sources, "zero-933.bin");
  const zero512 = path.join(sources, "zero-512.bin");
  const random256 = path.join(sources, "random-256.bin");
  const zeroNested = path.join(sources, "nested-zero.bin");
  ensureSparseFile(zero200, sizes.budget200);
  ensureSparseFile(zero933, sizes.budget933);
  ensureSparseFile(zero512, sizes.highRatio);
  ensurePseudoRandomFile(random256, sizes.random);
  ensureSparseFile(zeroNested, sizes.nested);

  const budget200 = path.join(files, "budget-200.7z");
  const budget933 = path.join(files, "budget-933.7z");
  const highRatio = path.join(files, "high-ratio-512.zip");
  const incompressible = path.join(files, "incompressible-256.zip");
  ensureArchive(budget200, "7z", [zero200]);
  ensureArchive(budget933, "7z", [zero933]);
  ensureArchive(highRatio, "zip", [zero512]);
  ensureArchive(incompressible, "zip", [random256]);

  const manyDir = path.join(sources, "many-entries");
  const manyCount = smoke ? 32 : 2048;
  const manyEntrySize = smoke ? 4096 : 64 * 1024;
  fs.mkdirSync(manyDir, { recursive: true });
  const manyInputs = [];
  for (let index = 0; index < manyCount; index += 1) {
    const filePath = path.join(manyDir, `entry-${String(index).padStart(4, "0")}.bin`);
    ensureSparseFile(filePath, manyEntrySize);
    manyInputs.push(filePath);
  }
  const manyEntries = path.join(files, "many-entries.zip");
  ensureArchive(manyEntries, "zip", manyInputs);

  const nestedInner = path.join(sources, "nested-inner.zip");
  const nestedMiddle = path.join(sources, "nested-middle.7z");
  const nestedOuter = path.join(files, "nested-three-level.zip");
  ensureArchive(nestedInner, "zip", [zeroNested]);
  ensureArchive(nestedMiddle, "7z", [nestedInner]);
  ensureArchive(nestedOuter, "zip", [nestedMiddle]);

  const cases = [
    ["budget-200", budget200, sizes.budget200, 1, fileSha256(zero200)],
    ["budget-933", budget933, sizes.budget933, 1, fileSha256(zero933)],
    ["high-ratio", highRatio, sizes.highRatio, 1, fileSha256(zero512)],
    ["incompressible", incompressible, sizes.random, 1, fileSha256(random256)],
    ["many-entries", manyEntries, manyCount * manyEntrySize, manyCount, null],
    ["nested-three-level", nestedOuter, sizes.nested, 1, fileSha256(zeroNested)],
  ].map(([id, filePath, uncompressedBytes, entryCount, expectedSha256]) => ({
    compressedBytes: fs.statSync(filePath).size,
    entryCount,
    expectedSha256,
    fileName: path.basename(filePath),
    id,
    kind: "generated",
    sha256: fileSha256(filePath),
    uncompressedBytes,
    url: `/__rom_weaver_corpus__/files/${encodeURIComponent(path.basename(filePath))}`,
  }));

  if (localCorpus) {
    if (!fs.statSync(localCorpus, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`Local corpus is not a directory: ${localCorpus}`);
    }
    for (const entry of fs.readdirSync(localCorpus, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const source = path.join(localCorpus, entry.name);
      const destinationName = `local-${entry.name}`;
      const destination = path.join(files, destinationName);
      linkOrCopy(source, destination);
      cases.push({
        compressedBytes: fs.statSync(destination).size,
        entryCount: null,
        expectedSha256: null,
        fileName: destinationName,
        id: `local-${entry.name}`,
        kind: "local",
        sha256: fileSha256(destination),
        uncompressedBytes: null,
        url: `/__rom_weaver_corpus__/files/${encodeURIComponent(destinationName)}`,
      });
    }
  }

  fs.writeFileSync(
    path.join(CORPUS_DIR, "manifest.json"),
    `${JSON.stringify({ cases, generatedAt: new Date().toISOString(), smoke, version: 1 }, null, 2)}\n`,
  );
  process.stdout.write(`Corpus ready: ${CORPUS_DIR}\n`);
};

try {
  main();
} catch (error) {
  process.stderr.write(`${error?.stack || String(error)}\n`);
  process.exitCode = 1;
}
