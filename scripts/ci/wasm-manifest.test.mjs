import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { makeTempDir } from "../test-temp-dirs.mjs";
import { buildManifest, checkManifest, parseManifest } from "./wasm-manifest.mjs";

const HASH_A = "a".repeat(64);
const write = (root, files) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
};
const artifact = () =>
  write(makeTempDir("wasm-manifest-"), {
    "rom-weaver-app.wasm": "module",
    "NOTICE": "notice",
    "third_party/licenses/crate-1.0.0/LICENSE-MIT": "mit",
  });

test("the manifest lists every file, sorted, as sha256sum lines", () => {
  const text = buildManifest(artifact());
  const lines = text.trimEnd().split("\n");
  assert.deepEqual(
    lines.map((line) => line.slice(66)),
    ["NOTICE", "rom-weaver-app.wasm", "third_party/licenses/crate-1.0.0/LICENSE-MIT"],
  );
  for (const line of lines) assert.match(line, /^[0-9a-f]{64} {2}\S+$/u);
});

test("a directory that matches its manifest passes", () => {
  const root = artifact();
  assert.equal(checkManifest(root, buildManifest(root)).length, 3);
});

test("an altered, added, or missing file fails the check", () => {
  const root = artifact();
  const text = buildManifest(root);
  writeFileSync(join(root, "rom-weaver-app.wasm"), "evil");
  assert.throws(() => checkManifest(root, text), /rom-weaver-app\.wasm does not match/u);

  const added = artifact();
  const addedText = buildManifest(added);
  write(added, { "extra.js": "x" });
  assert.throws(() => checkManifest(added, addedText), /extra\.js is not in the manifest/u);

  const missing = artifact();
  const missingText = buildManifest(missing);
  const smaller = write(makeTempDir("wasm-manifest-"), { "rom-weaver-app.wasm": "module" });
  assert.throws(() => checkManifest(smaller, missingText), /missing from the artifact/u);
});

test("a symlink in the artifact is refused", () => {
  const root = artifact();
  symlinkSync("/etc/passwd", join(root, "link"));
  assert.throws(() => buildManifest(root), /not a regular file/u);
  assert.throws(() => checkManifest(root, `${HASH_A}  NOTICE\n`), /not a regular file/u);
});

test("malformed manifests are rejected", () => {
  for (const text of [
    "",
    `${HASH_A}  NOTICE`,
    `${HASH_A} NOTICE\n`,
    `${HASH_A.toUpperCase()}  NOTICE\n`,
    `${HASH_A}  ../NOTICE\n`,
    `${HASH_A}  /etc/passwd\n`,
    `${HASH_A}  a//b\n`,
    `${HASH_A}  ./NOTICE\n`,
    `${HASH_A}  NOTICE\n${HASH_A}  NOTICE\n`,
  ])
    assert.throws(() => parseManifest(text), undefined, JSON.stringify(text));
});

test("an empty artifact has no manifest", () => {
  assert.throws(() => buildManifest(makeTempDir("wasm-manifest-")), /no files/u);
});
