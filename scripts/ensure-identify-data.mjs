#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CATALOG_FORMAT,
  GOODTOOLS_ARCHIVE,
  GOODTOOLS_ARCHIVE_SHA256,
  GOODTOOLS_DAT_PATH,
  GOODTOOLS_LICENSE,
  GOODTOOLS_RELEASE,
  GOODTOOLS_REPOSITORY,
  INDEX_FORMAT,
  LIBRETRO_PLATFORM_PATHS,
  LIBRETRO_REPOSITORY,
  LIBRETRO_REVISION,
  main as buildIdentifyData,
  OPENGOOD_STANDALONE_PLATFORMS,
  OPENGOOD_REPOSITORY,
  OPENGOOD_HEADERED_REVISION,
  OPENGOOD_REVISION,
  packGroupFor,
  slugifyPlatform,
} from "./build-identify-index.mjs";
import { CHECKSUM_ROUTER_FORMAT } from "../packages/rom-weaver-webapp/src/lib/identify/checksum-router.mjs";

const scriptDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const rootDir = resolve(scriptDir, "..");
const defaultDataDir = join(rootDir, "crates", "rom-weaver-cli", "data", "identify", "v1");
const expectedPackNames = [
  ...new Set(
    [...Object.keys(LIBRETRO_PLATFORM_PATHS), ...Object.keys(OPENGOOD_STANDALONE_PLATFORMS)].map(
      (platform) => `${slugifyPlatform(platform)}.pack`,
    ),
  ),
];
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
  if (
    catalog.generated?.libretroRevision !== LIBRETRO_REVISION ||
    catalog.generated?.opengoodRevision !== OPENGOOD_REVISION ||
    catalog.generated?.opengoodHeaderedRevision !== OPENGOOD_HEADERED_REVISION ||
    catalog.generated?.goodToolsRelease !== GOODTOOLS_RELEASE ||
    catalog.generated?.goodToolsArchiveSha256 !== GOODTOOLS_ARCHIVE_SHA256
  )
    return false;
  if (!Array.isArray(catalog.platforms)) return false;
  const slugs = new Set(catalog.platforms.map((platform) => platform.packSlug));
  return expectedPackNames.every((name) => slugs.has(name.slice(0, -".pack".length)));
};

// The browser routes a bare checksum through this file, so data built before
// the router existed - or with a router that no longer matches index.json - is
// stale and MUST be rebuilt.
const hasCurrentChecksumRouter = (dataDir, entry) => {
  if (!entry || entry.format !== CHECKSUM_ROUTER_FORMAT || typeof entry.file !== "string")
    return false;
  if (!Number.isSafeInteger(entry.rawBytes) || typeof entry.sha256 !== "string") return false;
  const routerPath = join(dataDir, entry.file);
  if (!existsSync(routerPath)) return false;
  const bytes = readFileSync(routerPath);
  if (bytes.length !== entry.rawBytes || sha256(bytes) !== entry.sha256) return false;
  if (!entry.brotliFile) return true;
  const brotliPath = join(dataDir, entry.brotliFile);
  return existsSync(brotliPath) && readFileSync(brotliPath).length === entry.brotliBytes;
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
    index.sources?.libretro?.url !== LIBRETRO_REPOSITORY ||
    index.sources?.libretro?.revision !== LIBRETRO_REVISION ||
    index.sources?.opengood?.url !== OPENGOOD_REPOSITORY ||
    index.sources?.opengood?.revision !== OPENGOOD_REVISION ||
    index.sources?.opengoodHeadered?.url !== OPENGOOD_REPOSITORY ||
    index.sources?.opengoodHeadered?.revision !== OPENGOOD_HEADERED_REVISION ||
    index.sources?.goodToolsHeadered?.url !== GOODTOOLS_REPOSITORY ||
    index.sources?.goodToolsHeadered?.license !== GOODTOOLS_LICENSE ||
    index.sources?.goodToolsHeadered?.release !== GOODTOOLS_RELEASE ||
    index.sources?.goodToolsHeadered?.archive !== GOODTOOLS_ARCHIVE ||
    index.sources?.goodToolsHeadered?.archiveSha256 !== GOODTOOLS_ARCHIVE_SHA256 ||
    index.sources?.goodToolsHeadered?.datPath !== GOODTOOLS_DAT_PATH
  ) {
    return false;
  }
  if (!hasCurrentCatalog(dataDir)) return false;
  if (!hasCurrentChecksumRouter(dataDir, index.checksumRoutes)) return false;
  if (!Array.isArray(index.systems)) return false;
  if (
    index.systems.some((system) => {
      const expectedGroup = packGroupFor(system.platform);
      return system.group !== expectedGroup || system.defaultPack !== (expectedGroup === "default");
    })
  )
    return false;

  const packNames = index.systems.map((system) => system.file).sort();
  if (packNames.length !== sortedExpectedPackNames.length) return false;
  if (packNames.some((name, position) => name !== sortedExpectedPackNames[position])) return false;

  const systemsByFile = new Map(index.systems.map((system) => [system.file, system]));
  const actualPackNames = readdirSync(dataDir).filter((name) => name.endsWith(".pack"));
  for (const name of actualPackNames) {
    const system = systemsByFile.get(name);
    if (!system) return false;
    if (system.source !== "libretro" && system.source !== "opengood") return false;
  }

  const verifyPack = (system) => {
    if (system.packFormat !== "RWFP1") return false;
    const packPath = join(dataDir, system.file);
    if (!existsSync(packPath)) return false;
    const bytes = readFileSync(packPath);
    if (bytes.subarray(0, 8).toString("binary") !== "RWFP1\0\0\0") return false;
    if (bytes.length !== system.rawBytes || sha256(bytes) !== system.sha256) return false;
    if (!system.brotliFile || !Number.isSafeInteger(system.brotliBytes)) return false;
    const brotliPath = join(dataDir, system.brotliFile);
    return existsSync(brotliPath) && readFileSync(brotliPath).length === system.brotliBytes;
  };
  return index.systems.every(verifyPack);
};

export const main = async (argv = process.argv.slice(2), dataDir = defaultDataDir) => {
  if (!argv.includes("--force") && hasCurrentData(dataDir)) {
    log(
      "info",
      `Libretro ${LIBRETRO_REVISION}, OpenGood ${OPENGOOD_REVISION}, and ` +
        `headered OpenGood ${OPENGOOD_HEADERED_REVISION} and GoodSNES ${GOODTOOLS_RELEASE} ` +
        `identify data is ready`,
    );
    return;
  }

  rmSync(dataDir, { recursive: true, force: true });
  log(
    "info",
    `building Libretro ${LIBRETRO_REVISION}, OpenGood ${OPENGOOD_REVISION}, and ` +
      `headered OpenGood ${OPENGOOD_HEADERED_REVISION} and GoodSNES ${GOODTOOLS_RELEASE} ` +
      `identify data`,
  );
  await buildIdentifyData(["--out", dataDir]);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    log("error", error.stack || error.message || error);
    process.exitCode = 1;
  });
}
