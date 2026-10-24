import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { SCREENSHOT_DIR, syncScreenshotSizes, webpSize } from "./sync-docs-screenshot-sizes.mjs";

const sizes = { "apply-patches-desktop-light": { height: 779, width: 1770 } };
const sizeOf = (name) => sizes[name];

test("screenshot tags with both dimensions take the captured size", () => {
  const markdown = [
    '<source type="image/avif" srcset="../screenshots/apply-patches-desktop-light.avif" width="1770" height="897">',
    '<img src="../screenshots/apply-patches-desktop-light.webp" alt="Patch stack" width="1770" height="897">',
  ].join("\n");
  assert.equal(
    syncScreenshotSizes(markdown, sizeOf),
    [
      '<source type="image/avif" srcset="../screenshots/apply-patches-desktop-light.avif" width="1770" height="779">',
      '<img src="../screenshots/apply-patches-desktop-light.webp" alt="Patch stack" width="1770" height="779">',
    ].join("\n"),
  );
});

test("display-width tags, unknown images, and other images stay unchanged", () => {
  const markdown = [
    '<img src="docs/screenshots/apply-patches-desktop-light.webp" alt="Patch stack" width="390">',
    '<img src="../screenshots/missing-desktop-light.webp" alt="Missing" width="10" height="10">',
    '<img src="https://example.com/badge.svg" width="10" height="10">',
  ].join("\n");
  assert.equal(syncScreenshotSizes(markdown, sizeOf), markdown);
});

test("committed WebP screenshots report their pixel size", () => {
  const file = path.join(SCREENSHOT_DIR, "first-sample-hello-world.webp");
  assert.deepEqual(webpSize(fs.readFileSync(file)), { height: 768, width: 1024 });
});
