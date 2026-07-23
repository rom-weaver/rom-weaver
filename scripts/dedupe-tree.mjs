/**
 * Collapse byte-identical files in a directory tree onto shared hardlinks.
 *
 * Written for the generated attribution bundle, where 435 files carry only 178
 * distinct texts - one Apache-2.0 copy alone repeats 59 times, because every
 * crate ships its own. Hardlinks (not symlinks) deliberately: consumers still
 * see ordinary regular files, so nothing in the serving path, the Docker build,
 * or a Windows checkout has to understand a link. Where hardlinks are not
 * preserved - `fs.cpSync`, a Cloudflare Pages upload - the tree simply expands
 * back to full copies, which is exactly today's behaviour.
 *
 * Call it again after any copy that re-expands the tree; it is idempotent.
 *
 * Never run this over a directory that `npm pack` will see. node-tar packs
 * entries on four parallel jobs and deadlocks emitting hardlink records, so
 * `npm pack` exits mid-stream with "Exit handler never called!" - which is why
 * the attribution generator leaves its output expanded and only the webapp
 * build, whose dist tree npm never packs, collapses it.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const listFiles = (directory) => {
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  };
  walk(directory);
  return files;
};

/**
 * Hardlink every duplicate onto the first occurrence in sorted order, so the
 * surviving inode is deterministic regardless of directory iteration order.
 *
 * @returns {{ linked: number, saved: number }}
 */
export const dedupeTree = (directory) => {
  if (!fs.existsSync(directory)) return { linked: 0, saved: 0 };

  const canonical = new Map();
  let linked = 0;
  let saved = 0;

  for (const filePath of listFiles(directory).sort()) {
    const contents = fs.readFileSync(filePath);
    const key = crypto.createHash("sha256").update(contents).digest("hex");
    const original = canonical.get(key);
    if (original === undefined) {
      canonical.set(key, filePath);
      continue;
    }
    // Already the same inode from a previous run - nothing to do.
    if (fs.statSync(original).ino === fs.statSync(filePath).ino) continue;

    // Link to a temporary name and rename over the target, so a failure part
    // way through never leaves the tree missing a license file.
    const temporary = `${filePath}.dedupe-tmp`;
    try {
      fs.linkSync(original, temporary);
    } catch {
      // Cross-device or a filesystem without hardlinks: keep the full copy.
      continue;
    }
    fs.renameSync(temporary, filePath);
    linked += 1;
    saved += contents.length;
  }

  return { linked, saved };
};
