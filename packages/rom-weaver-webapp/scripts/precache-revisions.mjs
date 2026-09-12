import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// Workbox treats revision:null URLs as self-versioned. Assign content revisions
// to fixed-name assets so an update can replace their cached bytes.
const HASHED_NAME = /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/u;

// Identify data files keep fixed names that can look hashed to the pattern
// above (`identify-checksum-routes.bin`), so they always get a content
// revision; one on an already hashed manifest is harmless. Bundles such as
// `identify-packs-<hash>.js` are still self-versioned.
const IDENTIFY_DATA_NAME = /^identify-.*\.(?:json|bin|pack)$/u;

const isSelfVersioned = (url) => {
  const name = path.basename(url);
  return !IDENTIFY_DATA_NAME.test(name) && HASHED_NAME.test(name);
};

/**
 * Workbox manifestTransform that stamps a content revision on every precached
 * asset whose file name is not self-versioned. An entry that already has a
 * revision, or whose file is missing from the build, is left untouched.
 */
const revisionUnhashedAssets =
  () =>
  (manifestEntries, _compilation, distDir = "dist") => {
    const manifest = manifestEntries.map((entry) => {
      if (entry.revision || !entry.url.startsWith("assets/") || isSelfVersioned(entry.url)) return entry;
      const filePath = path.join(distDir, entry.url);
      if (!existsSync(filePath)) return entry;
      const revision = createHash("sha256").update(readFileSync(filePath)).digest("hex").slice(0, 16);
      return { ...entry, revision };
    });
    return { manifest };
  };

export { revisionUnhashedAssets };
