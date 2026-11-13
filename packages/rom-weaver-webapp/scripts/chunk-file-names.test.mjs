import assert from "node:assert/strict";
import test from "node:test";
import { chunkFileNames } from "./vite-config/chunk-file-names.mjs";

test("published docs page chunks share the docs asset wildcard", () => {
  assert.equal(
    chunkFileNames({ moduleIds: ["\0virtual:rom-weaver-docs-page/docs/test-roms-cli"] }),
    "assets/docs-page-[hash].js",
  );
});

test("other lazy chunks keep their individual asset names", () => {
  assert.equal(chunkFileNames({ moduleIds: ["/src/webapp/components/home-page.tsx"] }), "assets/[name]-[hash].js");
});
