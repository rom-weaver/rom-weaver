import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { brotliCompressBuffer, brotliCompressBufferCached } from "./brotli-compress.mjs";

const source = (suffix = "") =>
  Buffer.from(
    Array.from({ length: 10_000 }, (_, index) => `${index % 997}|${index % 1009}|${suffix}\n`).join(
      "",
    ),
  );

async function withCache(run) {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "rom-weaver-brotli-cache-"));
  try {
    await run(cacheDir);
  } finally {
    await fs.rm(cacheDir, { force: true, recursive: true });
  }
}

test("cached Brotli matches synchronous compression for each profile", async () => {
  await withCache(async (cacheDir) => {
    const bytes = source();
    for (const parameterProfile of ["default", "large-window"]) {
      for (const quality of [0, 6, 11]) {
        const result = await brotliCompressBufferCached(bytes, {
          cacheDir,
          parameterProfile,
          quality,
        });
        assert.equal(result.cached, false);
        assert.deepEqual(
          result.compressed,
          brotliCompressBuffer(bytes, { parameterProfile, quality }),
        );
      }
    }
  });
});

test("cached Brotli returns a warm cache hit", async () => {
  await withCache(async (cacheDir) => {
    const bytes = source();
    const options = { cacheDir, quality: 11 };
    const first = await brotliCompressBufferCached(bytes, options);
    const second = await brotliCompressBufferCached(bytes, options);
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.deepEqual(second.compressed, first.compressed);
  });
});

test("cached Brotli replaces a corrupt entry", async () => {
  await withCache(async (cacheDir) => {
    const bytes = source();
    const options = { cacheDir, quality: 11 };
    const first = await brotliCompressBufferCached(bytes, options);
    const [entry] = await fs.readdir(cacheDir);
    await fs.writeFile(path.join(cacheDir, entry), "corrupt");
    const rebuilt = await brotliCompressBufferCached(bytes, options);
    assert.equal(first.cached, false);
    assert.equal(rebuilt.cached, false);
    assert.deepEqual(rebuilt.compressed, first.compressed);
    assert.equal((await brotliCompressBufferCached(bytes, options)).cached, true);
  });
});

test("cached Brotli separates sources and parameters", async () => {
  await withCache(async (cacheDir) => {
    const bytes = source();
    const changedBytes = source("changed");
    const variants = [
      { source: bytes, quality: 6, parameterProfile: "default" },
      { source: bytes, quality: 11, parameterProfile: "default" },
      { source: bytes, quality: 6, parameterProfile: "large-window" },
      { source: changedBytes, quality: 6, parameterProfile: "default" },
    ];
    for (const variant of variants) {
      const result = await brotliCompressBufferCached(variant.source, { cacheDir, ...variant });
      assert.equal(result.cached, false);
    }
    assert.equal((await fs.readdir(cacheDir)).length, variants.length);
  });
});

test("cached Brotli handles concurrent cache writes", async () => {
  await withCache(async (cacheDir) => {
    const bytes = source();
    const options = { cacheDir, quality: 11 };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => brotliCompressBufferCached(bytes, options)),
    );
    for (const result of results) assert.deepEqual(result.compressed, results[0].compressed);
    const entries = await fs.readdir(cacheDir);
    assert.equal(entries.length, 1);
    assert.match(entries[0], /\.br$/);
    assert.equal((await brotliCompressBufferCached(bytes, options)).cached, true);
  });
});

test("cached Brotli rejects invalid input", async () => {
  await assert.rejects(
    brotliCompressBufferCached(new Uint8Array([1]), { cacheDir: "/tmp/cache", quality: 11 }),
    /source must be a Buffer/,
  );
  await assert.rejects(
    brotliCompressBufferCached(Buffer.from("x"), { cacheDir: "", quality: 11 }),
    /cacheDir must be a non-empty path string/,
  );
});
