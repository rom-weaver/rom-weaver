#!/usr/bin/env node

// Materializes vendor/emulatorjs/data from the pinned EmulatorJS CDN drop.
// The tree is ~14 MB of prebuilt cores, so it is fetched rather than committed;
// vendor/emulatorjs.lock.json is the source of truth for the version and for a
// SHA-256 of every file, so a build is reproducible and a tampered or truncated
// download fails loudly instead of shipping.
//
//   node scripts/ensure-emulatorjs.mjs           # fetch anything missing/stale
//   node scripts/ensure-emulatorjs.mjs --force   # re-fetch every file
//
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const lockFile = join(rootDir, "vendor", "emulatorjs.lock.json");
const dataDir = join(rootDir, "vendor", "emulatorjs", "data");

const log = (level, message) => console.log(`[ensure-emulatorjs] ${level}: ${message}`);

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

const readLock = () => {
  if (!existsSync(lockFile)) throw new Error(`${lockFile} is missing; cannot resolve the pinned EmulatorJS drop`);
  const lock = JSON.parse(readFileSync(lockFile, "utf8"));
  if (!(lock.baseUrl && lock.files && Object.keys(lock.files).length))
    throw new Error(`${lockFile} has no baseUrl or file list`);
  return lock;
};

export const isFileCurrent = (targetPath, expectedHash) => {
  if (!existsSync(targetPath)) return false;
  return sha256(readFileSync(targetPath)) === expectedHash;
};

const removeUnlistedFiles = (directory, lockedPaths, relativeDirectory = "") => {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      removeUnlistedFiles(entryPath, lockedPaths, relativePath);
      if (!readdirSync(entryPath).length) rmSync(entryPath, { recursive: true });
      continue;
    }
    if (!lockedPaths.has(relativePath)) {
      unlinkSync(entryPath);
      log("trace", `removed unlisted asset ${relativePath}`);
    }
  }
};

// The CDN intermittently answers 5xx (a 520 broke a CI deploy); a short
// backoff rides those out. A hash mismatch is not transient and fails at once.
const FETCH_ATTEMPTS = 4;
const RETRYABLE_STATUSES = new Set([408, 425, 429]);
const fetchOnce = async (url, expectedHash) => {
  let response;
  let body;
  try {
    response = await fetch(url);
    if (response.ok) body = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    // Covers the headers phase and a stream dropped mid-body.
    return { transientError: new Error(`${url} failed: ${error.message}`) };
  }
  if (!response.ok) {
    const failure = new Error(`${url} returned HTTP ${response.status}`);
    if (response.status >= 500 || RETRYABLE_STATUSES.has(response.status)) return { transientError: failure };
    throw failure;
  }
  const actualHash = sha256(body);
  if (actualHash !== expectedHash) throw new Error(`${url} hash mismatch: expected ${expectedHash}, got ${actualHash}`);
  return { body };
};
const fetchVerified = async (url, expectedHash) => {
  for (let attempt = 1; ; attempt += 1) {
    const result = await fetchOnce(url, expectedHash);
    if (result.body) return result.body;
    if (attempt >= FETCH_ATTEMPTS) throw result.transientError;
    const delayMs = 1000 * 2 ** (attempt - 1);
    log("warn", `${result.transientError.message}; retrying in ${delayMs}ms (attempt ${attempt}/${FETCH_ATTEMPTS})`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
};

const main = async (argv = process.argv.slice(2)) => {
  const force = argv.includes("--force");
  const lock = readLock();
  removeUnlistedFiles(dataDir, new Set(Object.keys(lock.files)));
  const stale = Object.entries(lock.files).filter(
    ([relativePath, hash]) => force || !isFileCurrent(join(dataDir, relativePath), hash),
  );
  if (!stale.length) {
    log("info", `EmulatorJS ${lock.version} already vendored; nothing to fetch`);
    return;
  }
  log("info", `fetching ${stale.length}/${Object.keys(lock.files).length} files for EmulatorJS ${lock.version}`);
  for (const [relativePath, hash] of stale) {
    const targetPath = join(dataDir, relativePath);
    const body = await fetchVerified(`${lock.baseUrl}${relativePath}`, hash);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, body);
    log("trace", `wrote ${relativePath} (${body.length} bytes)`);
  }
  log("info", `EmulatorJS ${lock.version} vendored into ${dataDir}`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    log("error", error.message);
    process.exitCode = 1;
  });

export { main };
