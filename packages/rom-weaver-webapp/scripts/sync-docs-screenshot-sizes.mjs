#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SCREENSHOT_DIR = path.join(REPO_ROOT, "docs", "screenshots");
const SIZED_TAG = /<(?:img|source)\b[^>]*>/g;
const SCREENSHOT_SOURCE = /\b(?:src|srcset)="[^"]*screenshots\/([\w-]+)\.(?:webp|avif)"/;

// Read the pixel size from a WebP header: lossy (VP8), lossless (VP8L), or extended (VP8X).
const webpSize = (buffer) => {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP")
    throw new Error("Not a WebP file");
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8X") return { height: buffer.readUIntLE(27, 3) + 1, width: buffer.readUIntLE(24, 3) + 1 };
  if (chunk === "VP8L") {
    const bits = buffer.readUInt32LE(21);
    return { height: ((bits >>> 14) & 0x3fff) + 1, width: (bits & 0x3fff) + 1 };
  }
  if (chunk === "VP8 ") return { height: buffer.readUInt16LE(28) & 0x3fff, width: buffer.readUInt16LE(26) & 0x3fff };
  throw new Error(`Unsupported WebP chunk ${chunk}`);
};

// Rewrite width and height on every screenshot tag that declares both, so the
// markup always matches the captured pixels. AVIF and WebP share one capture,
// so both read the WebP size. Tags with only a width keep their display size.
const syncScreenshotSizes = (markdown, sizeOf) =>
  markdown.replace(SIZED_TAG, (tag) => {
    const name = SCREENSHOT_SOURCE.exec(tag)?.[1];
    const sized = /\swidth="\d+"/.test(tag) && /\sheight="\d+"/.test(tag);
    if (!(name && sized)) return tag;
    const size = sizeOf(name);
    if (!size) return tag;
    return tag.replace(/(\swidth=")\d+"/, `$1${size.width}"`).replace(/(\sheight=")\d+"/, `$1${size.height}"`);
  });

const markdownFiles = (directory) =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(entryPath);
    return entry.name.endsWith(".md") ? [entryPath] : [];
  });

const syncDocsScreenshotSizes = (repoRoot = REPO_ROOT) => {
  const screenshotDir = path.join(repoRoot, "docs", "screenshots");
  const sizes = new Map();
  const sizeOf = (name) => {
    if (!sizes.has(name)) {
      const file = path.join(screenshotDir, `${name}.webp`);
      sizes.set(name, fs.existsSync(file) ? webpSize(fs.readFileSync(file)) : undefined);
    }
    return sizes.get(name);
  };
  const changed = [];
  for (const file of [path.join(repoRoot, "README.md"), ...markdownFiles(path.join(repoRoot, "docs"))]) {
    const markdown = fs.readFileSync(file, "utf8");
    const synced = syncScreenshotSizes(markdown, sizeOf);
    if (synced === markdown) continue;
    fs.writeFileSync(file, synced);
    changed.push(path.relative(repoRoot, file));
  }
  return changed;
};

export { SCREENSHOT_DIR, syncDocsScreenshotSizes, syncScreenshotSizes, webpSize };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const changed = syncDocsScreenshotSizes();
  console.log(changed.length ? `Synced screenshot sizes in ${changed.join(", ")}` : "Screenshot sizes already match");
}
