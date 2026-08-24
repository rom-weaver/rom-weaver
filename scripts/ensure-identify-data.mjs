#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CATALOG_FORMAT,
  INDEX_FORMAT,
  main as buildIdentifyData,
  OPENGOOD_PLATFORMS,
  OPENGOOD_REPOSITORY,
  OPENGOOD_REVISION,
  slugifyPlatform,
} from "./build-hasheous-identify-index.mjs";

const scriptDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const rootDir = resolve(scriptDir, "..");
const defaultDataDir = join(rootDir, "crates", "rom-weaver-cli", "data", "identify", "v1");
const expectedPackNames = Object.keys(OPENGOOD_PLATFORMS).map((platform) => `${slugifyPlatform(platform)}.pack`);
const sortedExpectedPackNames = [...expectedPackNames].sort();

const log = (level, message) => console.log(`[ensure-identify-data] ${level}: ${message}`);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// A data dir built before the catalog existed passes every pack check, so the
// catalog MUST be validated too - otherwise builds silently ship without it.
const hasCurrentCatalog = (dataDir) => {
  const catalogPath = join(dataDir, "catalog.json");
  if (!existsSync(catalogPath)) return false;
  let catalog;
  try {
    catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  } catch {
    return false;
  }
  if (catalog.format !== CATALOG_FORMAT) return false;
  if (catalog.generated?.opengoodRevision !== OPENGOOD_REVISION) return false;
  if (!Array.isArray(catalog.platforms)) return false;
  const slugs = new Set(catalog.platforms.map((platform) => platform.packSlug));
  return Object.keys(OPENGOOD_PLATFORMS).every((platform) => slugs.has(slugifyPlatform(platform)));
};

export const hasCurrentData = (dataDir = defaultDataDir) => {
  const indexPath = join(dataDir, "index.json");
  if (!existsSync(indexPath)) return false;
  let index;
  try {
    index = JSON.parse(readFileSync(indexPath, "utf8"));
  } catch {
    return false;
  }
  if (
    index.format !== INDEX_FORMAT ||
    index.catalog !== "catalog.json" ||
    index.sources?.opengood?.url !== OPENGOOD_REPOSITORY ||
    index.sources?.opengood?.revision !== OPENGOOD_REVISION
  ) {
    return false;
  }
  if (!hasCurrentCatalog(dataDir)) return false;
  if (!Array.isArray(index.systems) || index.systems.length !== expectedPackNames.length) return false;
  const actualPackNames = readdirSync(dataDir)
    .filter((name) => name.endsWith(".pack"))
    .sort();
  if (actualPackNames.length !== expectedPackNames.length) return false;
  if (actualPackNames.some((name, index) => name !== sortedExpectedPackNames[index])) return false;
  return expectedPackNames.every((name) => {
    const system = index.systems.find((candidate) => candidate.file === name);
    if (!system || system.source !== "opengood") return false;
    const packPath = join(dataDir, name);
    if (!existsSync(packPath)) return false;
    const bytes = readFileSync(packPath);
    return bytes.length === system.rawBytes && sha256(bytes) === system.sha256;
  });
};

export const main = async (argv = process.argv.slice(2), dataDir = defaultDataDir) => {
  if (!argv.includes("--force") && hasCurrentData(dataDir)) {
    log("info", `OpenGood ${OPENGOOD_REVISION} identify data is ready`);
    return;
  }

  rmSync(dataDir, { recursive: true, force: true });
  log("info", `building OpenGood ${OPENGOOD_REVISION} identify data`);
  await buildIdentifyData(["--opengood-only", "--no-brotli", "--out", dataDir]);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    log("error", error.stack || error.message || error);
    process.exitCode = 1;
  });
}
