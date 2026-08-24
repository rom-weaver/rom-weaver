import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { main as buildIdentifyData, OPENGOOD_PLATFORMS, OPENGOOD_REVISION } from "./build-hasheous-identify-index.mjs";
import { hasCurrentData } from "./ensure-identify-data.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(scriptDir, "../tests/fixtures/identify");

// The cache is pre-seeded at the exact path downloadOpenGoodDat would use, so
// no test touches the network.
function seedOpenGoodCache(cacheDir) {
  const datDir = join(cacheDir, "opengood", OPENGOOD_REVISION);
  mkdirSync(datDir, { recursive: true });
  const fixture = readFileSync(join(fixtureDir, "OpenNES.dat"));
  for (const datFiles of Object.values(OPENGOOD_PLATFORMS)) {
    for (const datFile of datFiles) writeFileSync(join(datDir, datFile), fixture);
  }
}

async function buildCurrentDataDir() {
  const work = mkdtempSync(join(os.tmpdir(), "rw-ensure-identify-"));
  const cacheDir = join(work, "cache");
  const dataDir = join(work, "data");
  seedOpenGoodCache(cacheDir);
  await buildIdentifyData(["--opengood-only", "--no-brotli", "--cache-dir", cacheDir, "--out", dataDir]);
  return { dataDir, work };
}

test("hasCurrentData accepts a freshly built data dir", async () => {
  const { dataDir, work } = await buildCurrentDataDir();
  try {
    assert.equal(hasCurrentData(dataDir), true);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("hasCurrentData rejects a data dir without catalog.json", async () => {
  const { dataDir, work } = await buildCurrentDataDir();
  try {
    rmSync(join(dataDir, "catalog.json"));
    assert.equal(hasCurrentData(dataDir), false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("hasCurrentData rejects a pre-catalog index.json", async () => {
  const { dataDir, work } = await buildCurrentDataDir();
  try {
    const indexPath = join(dataDir, "index.json");
    const index = JSON.parse(readFileSync(indexPath, "utf8"));
    delete index.catalog;
    writeFileSync(indexPath, JSON.stringify(index, null, 2));
    assert.equal(hasCurrentData(dataDir), false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("hasCurrentData rejects a catalog with an unknown format", async () => {
  const { dataDir, work } = await buildCurrentDataDir();
  try {
    const catalogPath = join(dataDir, "catalog.json");
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    catalog.format = "rom-weaver-identify-catalog-v0";
    writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
    assert.equal(hasCurrentData(dataDir), false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("hasCurrentData rejects a catalog from another OpenGood revision", async () => {
  const { dataDir, work } = await buildCurrentDataDir();
  try {
    const catalogPath = join(dataDir, "catalog.json");
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    catalog.generated.opengoodRevision = "0000000000000000000000000000000000000000";
    writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
    assert.equal(hasCurrentData(dataDir), false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("hasCurrentData rejects a catalog missing an OpenGood platform", async () => {
  const { dataDir, work } = await buildCurrentDataDir();
  try {
    const catalogPath = join(dataDir, "catalog.json");
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    catalog.platforms = catalog.platforms.slice(1);
    writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
    assert.equal(hasCurrentData(dataDir), false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
