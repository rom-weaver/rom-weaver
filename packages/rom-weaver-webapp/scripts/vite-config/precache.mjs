import fs from "node:fs";
import path from "node:path";
import { initialPrecacheUrls } from "../offline-downloads.mjs";
import { rootDir } from "./paths.mjs";

// The service worker cannot see how big its own precache is: workbox measures
// every entry, sums the sizes for its build log, then deletes the field from
// each entry before injecting the manifest (workbox-build's transform-manifest
// - ManifestEntry is {integrity?, revision, url}). A manifestTransform runs
// while the sizes are still there, so this writes them out beside the bundle
// for the worker to fetch when it installs. Without it the install stage can
// only count entries, and a 4 MB wasm module weighs the same as a translation
// file. Emitted at the dist root, which keeps it out of the precache globs.
const PRECACHE_SIZES_FILENAME = "precache-sizes.json";

export const writePrecacheSizes =
  () =>
  (manifestEntries, _compilation, distDir = path.resolve(rootDir, "dist")) => {
    const sizes = {};
    for (const entry of manifestEntries) {
      if (typeof entry.size === "number") sizes[entry.url] = entry.size;
    }
    fs.writeFileSync(path.join(distDir, PRECACHE_SIZES_FILENAME), `${JSON.stringify(sizes)}\n`);
    return { manifest: manifestEntries };
  };

export const preparePrecacheEntries = () => (entries) => {
  const distDir = path.resolve(rootDir, "dist");
  const initial = initialPrecacheUrls(distDir);
  const manifest = entries.map((entry) => ({
    ...entry,
    install: initial.has(entry.url),
    sizeBytes: entry.size,
  }));
  return { manifest };
};
