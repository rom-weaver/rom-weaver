import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { revisionUnhashedAssets } from "./precache-revisions.mjs";

const buildDist = (files) => {
  const distDir = mkdtempSync(path.join(tmpdir(), "precache-revisions-"));
  mkdirSync(path.join(distDir, "assets"), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(distDir, name), body);
  return distDir;
};

test("revisionUnhashedAssets: stamps a content revision on an asset with no hash in its name", () => {
  const distDir = buildDist({ "assets/identify-index.json": '{"format":"rom-weaver-identify-system-pack-v1"}' });

  const { manifest } = revisionUnhashedAssets()(
    [{ revision: null, url: "assets/identify-index.json" }],
    undefined,
    distDir,
  );

  assert.equal(manifest.length, 1);
  assert.match(manifest[0].revision, /^[0-9a-f]{16}$/u);
});

test("revisionUnhashedAssets: a changed file gets a different revision, so the worker refetches it", () => {
  const first = buildDist({ "assets/identify-index.json": '{"format":"…-v5"}' });
  const second = buildDist({ "assets/identify-index.json": '{"format":"…-v1"}' });
  const entries = [{ revision: null, url: "assets/identify-index.json" }];

  const before = revisionUnhashedAssets()(entries, undefined, first).manifest[0].revision;
  const after = revisionUnhashedAssets()(entries, undefined, second).manifest[0].revision;

  assert.notEqual(before, after);
});

test("revisionUnhashedAssets: leaves self-versioned and already-revisioned entries alone", () => {
  const distDir = buildDist({
    "assets/identify-packs-DPmhN2ZO.js": "export {};",
    "assets/manifest.json": "{}",
  });

  const { manifest } = revisionUnhashedAssets()(
    [
      { revision: null, url: "assets/identify-packs-DPmhN2ZO.js" },
      { revision: "r1", url: "assets/manifest.json" },
      { revision: null, url: "index.html" },
    ],
    undefined,
    distDir,
  );

  assert.equal(manifest[0].revision, null);
  assert.equal(manifest[1].revision, "r1");
  assert.equal(manifest[2].revision, null);
});

test("revisionUnhashedAssets: leaves an entry whose file the build did not emit", () => {
  const { manifest } = revisionUnhashedAssets()(
    [{ revision: null, url: "assets/identify-catalog.json" }],
    undefined,
    buildDist({}),
  );

  assert.equal(manifest[0].revision, null);
});
