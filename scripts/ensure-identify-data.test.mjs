import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  INDEX_FORMAT,
  LIBRETRO_PLATFORM_PATHS,
  LIBRETRO_REPOSITORY,
  LIBRETRO_REVISION,
  OPENGOOD_STANDALONE_PLATFORMS,
  OPENGOOD_REPOSITORY,
  OPENGOOD_REVISION,
  slugifyPlatform,
} from "./build-identify-index.mjs";
import { hasCurrentData } from "./ensure-identify-data.mjs";

function buildCurrentDataDir() {
  const work = mkdtempSync(join(os.tmpdir(), "rw-ensure-identify-"));
  const dataDir = join(work, "data");
  mkdirSync(dataDir, { recursive: true });
  const platforms = [
    ...Object.keys(LIBRETRO_PLATFORM_PATHS).map((platform) => [platform, "libretro"]),
    ...Object.keys(OPENGOOD_STANDALONE_PLATFORMS).map((platform) => [platform, "opengood"]),
  ];
  const systems = platforms.map(([platform, source]) => {
    const slug = slugifyPlatform(platform);
    const bytes = Buffer.from(`RWFP4\0\0\0pack:${slug}`, "binary");
    writeFileSync(join(dataDir, `${slug}.pack`), bytes);
    writeFileSync(join(dataDir, `${slug}.pack.br`), bytes);
    return {
      file: `${slug}.pack`,
      brotliFile: `${slug}.pack.br`,
      brotliBytes: bytes.length,
      rawBytes: bytes.length,
      packFormat: "RWFP4",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      source,
    };
  });
  const catalog = {
    format: "rom-weaver-identify-catalog-v1",
    generated: { libretroRevision: LIBRETRO_REVISION, opengoodRevision: OPENGOOD_REVISION },
    platforms: platforms.map(([platform, source]) => ({
      canonicalPlatform: platform,
      packSlug: slugifyPlatform(platform),
      source,
    })),
  };
  writeFileSync(join(dataDir, "catalog.json"), JSON.stringify(catalog));
  writeFileSync(
    join(dataDir, "index.json"),
    JSON.stringify({
      catalog: "catalog.json",
      format: INDEX_FORMAT,
      sources: {
        libretro: { revision: LIBRETRO_REVISION, url: LIBRETRO_REPOSITORY },
        opengood: { revision: OPENGOOD_REVISION, url: OPENGOOD_REPOSITORY },
      },
      systems,
    }),
  );
  return { dataDir, work };
}

test("hasCurrentData accepts a freshly built data dir", async () => {
  const { dataDir, work } = buildCurrentDataDir();
  try {
    assert.equal(hasCurrentData(dataDir), true);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("hasCurrentData rejects a data dir without catalog.json", async () => {
  const { dataDir, work } = buildCurrentDataDir();
  try {
    rmSync(join(dataDir, "catalog.json"));
    assert.equal(hasCurrentData(dataDir), false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("hasCurrentData rejects a pre-catalog index.json", async () => {
  const { dataDir, work } = buildCurrentDataDir();
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
  const { dataDir, work } = buildCurrentDataDir();
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
  const { dataDir, work } = buildCurrentDataDir();
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

test("hasCurrentData rejects a pack file the index never listed", async () => {
  const { dataDir, work } = buildCurrentDataDir();
  try {
    writeFileSync(join(dataDir, "mystery.pack"), Buffer.from("mystery"));
    assert.equal(hasCurrentData(dataDir), false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("hasCurrentData rejects a catalog missing an OpenGood platform", async () => {
  const { dataDir, work } = buildCurrentDataDir();
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
