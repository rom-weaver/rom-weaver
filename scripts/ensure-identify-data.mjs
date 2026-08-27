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
  REDUMP_PLATFORMS,
  slugifyPlatform,
} from "./build-identify-index.mjs";

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

export const hasCurrentData = (dataDir = defaultDataDir, options = {}) => {
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
  if (!Array.isArray(index.systems)) return false;

  // The OpenGood set must be exactly the 17 expected packs.
  const opengoodPackNames = index.systems
    .filter((system) => system.source === "opengood")
    .map((system) => system.file)
    .sort();
  if (opengoodPackNames.length !== sortedExpectedPackNames.length) return false;
  if (opengoodPackNames.some((name, position) => name !== sortedExpectedPackNames[position])) return false;

  const systemsByFile = new Map(index.systems.map((system) => [system.file, system]));
  const actualPackNames = readdirSync(dataDir).filter((name) => name.endsWith(".pack"));
  for (const name of actualPackNames) {
    const system = systemsByFile.get(name);
    if (!system) return false;
    if (system.source !== "opengood" && system.source !== "redump") return false;
  }

  if (options.redumpAll) {
    const redumpSlugs = new Set(
      index.systems.filter((system) => system.source === "redump").map((system) => system.slug),
    );
    if (Object.keys(REDUMP_PLATFORMS).some((platform) => !redumpSlugs.has(slugifyPlatform(platform)))) {
      return false;
    }
  }

  const verifyPack = (system) => {
    const packPath = join(dataDir, system.file);
    if (!existsSync(packPath)) return false;
    const bytes = readFileSync(packPath);
    return bytes.length === system.rawBytes && sha256(bytes) === system.sha256;
  };
  return index.systems.every(verifyPack);
};

export const main = async (argv = process.argv.slice(2), dataDir = defaultDataDir) => {
  const redumpAll = argv.includes("--redump-all");
  if (!argv.includes("--force") && hasCurrentData(dataDir, { redumpAll })) {
    log("info", `OpenGood ${OPENGOOD_REVISION}${redumpAll ? " and Redump" : ""} identify data is ready`);
    return;
  }

  rmSync(dataDir, { recursive: true, force: true });
  log("info", `building OpenGood ${OPENGOOD_REVISION} identify data`);
  await buildIdentifyData([
    redumpAll ? "--redump-all" : "--opengood-only",
    "--no-brotli",
    "--out",
    dataDir,
  ]);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    log("error", error.stack || error.message || error);
    process.exitCode = 1;
  });
}
