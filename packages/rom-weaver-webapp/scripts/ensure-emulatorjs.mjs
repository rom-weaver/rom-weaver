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
// Set ROM_WEAVER_SKIP_EMULATORJS=1 to skip (the EmulatorJS tester is the only
// thing that needs it; the rest of the webapp builds fine without it).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const fetchVerified = async (url, expectedHash) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  const actualHash = sha256(body);
  if (actualHash !== expectedHash) throw new Error(`${url} hash mismatch: expected ${expectedHash}, got ${actualHash}`);
  return body;
};

const main = async (env = process.env, argv = process.argv.slice(2)) => {
  if (String(env.ROM_WEAVER_SKIP_EMULATORJS || "") === "1") {
    log("warn", "ROM_WEAVER_SKIP_EMULATORJS=1 set; skipping the EmulatorJS fetch");
    return;
  }
  const force = argv.includes("--force");
  const lock = readLock();
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
