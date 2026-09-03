import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// Workbox reads `revision: null` as "this URL is self-versioned": the file name
// carries a content hash, so the precached copy is current forever and the
// worker never re-fetches it. vite-plugin-pwa stamps that on everything under
// assets/, which is true of every emitted bundle - and false for the identify
// index and catalog, whose names are fixed so a deployment can advertise a new
// pack set. Precached under a null revision they instead FREEZE at whatever a
// device stored first: a nightly that cached the RWFP5 index kept serving it
// after the format became RWFP1, and every lookup on that device failed with
// "ROM identify index is invalid" while the origin served the new file.
//
// So: any asset whose name carries no hash gets a real one, from its bytes.
const HASHED_NAME = /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/u;

const isSelfVersioned = (url) => HASHED_NAME.test(path.basename(url));

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
