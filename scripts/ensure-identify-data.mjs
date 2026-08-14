#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  INDEX_FORMAT,
  main as buildIdentifyData,
  OPENGOOD_PLATFORMS,
  OPENGOOD_REPOSITORY,
  OPENGOOD_REVISION,
  slugifyPlatform,
} from "./build-hasheous-identify-index.mjs";

const scriptDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const rootDir = resolve(scriptDir, "..");
const dataDir = join(rootDir, "crates", "rom-weaver-cli", "data", "identify", "v1");
const indexPath = join(dataDir, "index.json");
const expectedPackNames = Object.keys(OPENGOOD_PLATFORMS).map(
  (platform) => `${slugifyPlatform(platform)}.pack`,
);
const sortedExpectedPackNames = [...expectedPackNames].sort();

const log = (level, message) => console.log(`[ensure-identify-data] ${level}: ${message}`);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const hasCurrentData = () => {
  if (!existsSync(indexPath)) return false;
  let index;
  try {
    index = JSON.parse(readFileSync(indexPath, "utf8"));
  } catch {
    return false;
  }
  if (
    index.format !== INDEX_FORMAT ||
    index.sources?.opengood?.url !== OPENGOOD_REPOSITORY ||
    index.sources?.opengood?.revision !== OPENGOOD_REVISION
  ) {
    return false;
  }
  if (!Array.isArray(index.systems) || index.systems.length !== expectedPackNames.length)
    return false;
  const actualPackNames = readdirSync(dataDir).filter((name) => name.endsWith(".pack")).sort();
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

export const main = async (argv = process.argv.slice(2)) => {
  if (!argv.includes("--force") && hasCurrentData()) {
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
