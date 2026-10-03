import assert from "node:assert/strict";
import { test } from "node:test";
import { createSitemapSource } from "./vite-config/seo-html.mjs";

test("the sitemap includes the public compression workflow", () => {
  const sitemap = createSitemapSource();
  assert.ok(sitemap.includes("<loc>https://rom-weaver.com/compress</loc>"));
});

test("the sitemap contains each indexable workflow once and excludes beta tools", () => {
  const locations = [...createSitemapSource().matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]);
  assert.equal(locations.length, new Set(locations).size);
  for (const slug of [
    "apply-patches",
    "bundle-patches",
    "checksum",
    "create-patch",
    "extract",
    "identify-rom",
    "test-rom",
  ]) {
    assert.ok(locations.includes(`https://rom-weaver.com/${slug}`), slug);
  }
  for (const slug of ["trim", "ppf-undo", "save-editor"]) {
    assert.ok(!locations.includes(`https://rom-weaver.com/${slug}`), slug);
  }
});
