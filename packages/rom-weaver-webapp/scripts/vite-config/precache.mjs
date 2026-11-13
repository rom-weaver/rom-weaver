import fs from "node:fs";
import path from "node:path";
import { injectManifest } from "workbox-build";
import { initialPrecacheUrls } from "../offline-downloads.mjs";
import { revisionUnhashedAssets } from "../precache-revisions.mjs";

// The service worker cannot see how big its own precache is: workbox measures
// every entry, sums the sizes for its build log, then deletes the field from
// each entry before injecting the manifest (workbox-build's transform-manifest
// - ManifestEntry is {integrity?, revision, url}). A manifestTransform runs
// while the sizes are still there, so this writes them out beside the bundle
// for the worker to fetch when it installs. Without it the install stage can
// only count entries, and a 4 MB wasm module weighs the same as a translation
// file. Emitted at the dist root, which keeps it out of the precache globs.
const PRECACHE_SIZES_FILENAME = "precache-sizes.json";

const writePrecacheSizes = (distDir) => (manifestEntries) => {
  const sizes = {};
  for (const entry of manifestEntries) {
    if (typeof entry.size === "number") sizes[entry.url] = entry.size;
  }
  fs.writeFileSync(path.join(distDir, PRECACHE_SIZES_FILENAME), `${JSON.stringify(sizes)}\n`);
  return { manifest: manifestEntries };
};

const preparePrecacheEntries = (distDir) => (entries) => {
  const initial = initialPrecacheUrls(distDir);
  const manifest = entries.map((entry) => ({
    ...entry,
    install: initial.has(entry.url),
    sizeBytes: entry.size,
  }));
  return { manifest };
};

/**
 * Writes `swDest` as the `swSrc` service worker with the precache manifest of
 * `distDir` injected, plus `precache-sizes.json`. `swSrc` MUST still hold the
 * `self.__WB_MANIFEST` placeholder, so a restamp injects from the saved
 * template rather than from the already injected worker.
 */
export const injectPrecacheManifest = async ({ distDir, swDest, swSrc }) => {
  const { warnings } = await injectManifest({
    // Hashed asset names already change with their bytes; only the rest need a revision.
    dontCacheBustURLsMatching: /^assets\//,
    globDirectory: distDir,
    // The checksum router and the title index are warm-up data like the
    // packs, so neither the raw files nor their brotli sidecars join the
    // precache.
    globIgnores: [
      "**/*.map",
      "assets/identify-*.pack.br",
      "assets/identify-*.bin",
      "assets/identify-*.bin.br",
      "assets/identify-cheats-*.json.br",
      "assets/identify-title-index.json",
      "assets/identify-title-index.json.br",
    ],
    globPatterns: [
      // Every route ships its own prerendered document, so precache them all:
      // offline, a route the user has not visited yet has nothing in the runtime
      // cache, and without its own shell it falls back to the patcher one and
      // hydrates through a mismatch. Only the directory-index copy is listed -
      // the `<slug>.html` twin is the same bytes, and the service worker looks
      // routes up by the index form (see matchRouteDocument).
      "index.html",
      "**/index.html",
      "404.html",
      "manifest.json",
      "rom-weaver-*.schema.json",
      "docs.md",
      "docs/*.md",
      "NOTICE",
      "WEBAPP_NOTICE",
      "emulatorjs/LICENSE",
      "emulatorjs/NOTICE",
      "emulatorjs/bios/*.rom",
      "emulatorjs/bios/*.bin",
      "logo.svg",
      "first-create.zip",
      "first-weave.zip",
      "favicon.ico",
      "favicon*.png",
      "favicon*.svg",
      "apple-touch-icon.png",
      "hello-world.nes",
      "modified-world.nes",
      "assets/**/*.{css,js,mjs,json,png,svg,jpg,jpeg,webp,woff2,wasm}",
      "docs/screenshots/*.{avif,webp}",
      "icon-192.png",
      "icon-512.png",
      "icon-maskable-512.png",
    ],
    // Manifest revisions track precached shell assets; identify packs load
    // through background warm-up or on demand, outside the precache.
    manifestTransforms: [
      (entries) => revisionUnhashedAssets()(entries, undefined, distDir),
      preparePrecacheEntries(distDir),
      writePrecacheSizes(distDir),
    ],
    // Large WASM entries MUST remain in the deferred manifest for the offline installer.
    maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
    swDest,
    swSrc,
  });
  for (const warning of warnings) console.warn(`[rom-weaver] precache: ${warning}`);
};
