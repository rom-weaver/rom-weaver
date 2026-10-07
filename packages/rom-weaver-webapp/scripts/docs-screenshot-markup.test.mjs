import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DOCS_DIR = path.join(REPO_ROOT, "docs");

const markdownFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(entryPath);
    return entry.name.endsWith(".md") ? [entryPath] : [];
  });

const webpSize = (bytes) => {
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8X") return [bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1];
  if (chunk === "VP8 ") return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
  const bits = bytes.readUInt32LE(21);
  return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
};

const avifSize = (bytes) => {
  const box = bytes.indexOf("ispe");
  if (box === -1) throw new Error("AVIF has no ispe box");
  return [bytes.readUInt32BE(box + 8), bytes.readUInt32BE(box + 12)];
};

const imageSize = (file) => {
  const bytes = fs.readFileSync(file);
  return file.endsWith(".avif") ? avifSize(bytes) : webpSize(bytes);
};

test("docs screenshot width and height attributes match the image files", () => {
  const checked = [];
  for (const file of markdownFiles(DOCS_DIR)) {
    const markdown = fs.readFileSync(file, "utf8");
    for (const [tag] of markdown.matchAll(/<(?:img|source)\b[^>]*screenshots\/[^>]*>/g)) {
      const source = /(?:srcset|src)="([^"]*screenshots\/[^"]+)"/.exec(tag)?.[1];
      const width = Number(/\swidth="(\d+)"/.exec(tag)?.[1]);
      const height = Number(/\sheight="(\d+)"/.exec(tag)?.[1]);
      const label = `${path.relative(REPO_ROOT, file)}: ${source}`;
      assert.ok(width && height, `${label} needs width and height`);
      assert.deepEqual([width, height], imageSize(path.resolve(path.dirname(file), source)), label);
      checked.push(label);
    }
  }
  assert.ok(checked.length > 0);
});
