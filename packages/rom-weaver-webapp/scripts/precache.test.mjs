import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeTempDir } from "../../../scripts/test-temp-dirs.mjs";
import { injectPrecacheManifest } from "./vite-config/precache.mjs";

test("injectPrecacheManifest: an asset over the size limit fails instead of dropping out of the precache", async () => {
  const distDir = makeTempDir("precache-oversize-");
  mkdirSync(path.join(distDir, ".vite"), { recursive: true });
  mkdirSync(path.join(distDir, "assets"), { recursive: true });
  writeFileSync(
    path.join(distDir, ".vite", "manifest.json"),
    JSON.stringify({ "index.html": { file: "assets/index.js" } }),
  );
  writeFileSync(path.join(distDir, "index.html"), "<!doctype html>");
  writeFileSync(path.join(distDir, "assets", "index.js"), "");
  writeFileSync(path.join(distDir, "assets", "module.wasm"), Buffer.alloc(17 * 1024 * 1024));
  const swSrc = path.join(distDir, "sw-template.js");
  writeFileSync(swSrc, "self.__WB_MANIFEST;\n");

  await assert.rejects(injectPrecacheManifest({ distDir, swDest: path.join(distDir, "sw.js"), swSrc }), (error) => {
    assert.match(error.message, /maximumFileSizeToCacheInBytes/u);
    assert.match(error.message, /assets\/module\.wasm/u);
    return true;
  });
});
