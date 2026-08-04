import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverTestFiles, parseShard, selectShard } from "./run-browser-tests.mjs";

// selectShard weighs by fs.statSync(file).size, so fixtures use real temp
// files padded to a controlled byte size rather than an injectable weight.
const makeFixtureFiles = (root, sizes) =>
  sizes.map((size, index) => {
    const file = path.join(root, `fixture-${index}.browser.test.js`);
    fs.writeFileSync(file, "x".repeat(size));
    return file;
  });

test("selectShard: every file lands in exactly one shard across the full range", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rom-weaver-shard-"));
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const files = makeFixtureFiles(root, [500, 10, 300, 1, 200, 900, 50, 700, 20, 400]);

  const total = 3;
  const perShard = Array.from({ length: total }, (_, index) => selectShard(files, { index: index + 1, total }));
  const combined = perShard.flat();

  assert.deepEqual(
    combined.slice().sort((left, right) => Number(left > right) - Number(left < right)),
    files.slice().sort((left, right) => Number(left > right) - Number(left < right)),
    "every file appears, no duplicates",
  );
  assert.equal(new Set(combined).size, files.length, "no file appears in more than one shard");
});

test("selectShard: no shard is empty for a reasonable file count and shard total", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rom-weaver-shard-"));
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const files = makeFixtureFiles(root, [100, 200, 300, 400, 500, 600]);

  const total = 3;
  for (let index = 1; index <= total; index += 1) {
    const shardFiles = selectShard(files, { index, total });
    assert.ok(shardFiles.length > 0, `shard ${index}/${total} must not be empty`);
  }
});

test("selectShard: weights balance roughly across shards with similar-sized files", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rom-weaver-shard-"));
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const files = makeFixtureFiles(root, [100, 110, 90, 105, 95, 100, 100, 90, 110, 95]);

  const total = 2;
  const weightOf = (shardFiles) => shardFiles.reduce((sum, file) => sum + fs.statSync(file).size, 0);
  const weights = Array.from({ length: total }, (_, index) =>
    weightOf(selectShard(files, { index: index + 1, total })),
  );

  const [min, max] = [Math.min(...weights), Math.max(...weights)];
  assert.ok(max - min <= max * 0.25, `shard weights should be close: got ${weights.join(", ")}`);
});

test("selectShard: heavier files spread out rather than piling into one shard", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rom-weaver-shard-"));
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  // One huge file plus several small ones: the greedy algorithm should still
  // give every other shard some of the small files rather than leaving them
  // empty because the first shard "used its turn" on the big file.
  const files = makeFixtureFiles(root, [1000, 10, 10, 10, 10, 10]);

  const total = 2;
  const shardOne = selectShard(files, { index: 1, total });
  const shardTwo = selectShard(files, { index: 2, total });

  assert.ok(shardOne.length > 0 && shardTwo.length > 0, "both shards get files");
  assert.equal(shardOne.length + shardTwo.length, files.length);
});

test("selectShard: returns all files unchanged when shard is null", () => {
  const files = ["/a/b.js", "/a/c.js"];
  assert.deepEqual(selectShard(files, null), files);
});

test("parseShard: parses valid <index>/<total> specs", () => {
  assert.deepEqual(parseShard("1/2", "--shard"), { index: 1, total: 2 });
  assert.deepEqual(parseShard("2/2", "--shard"), { index: 2, total: 2 });
});

test("parseShard: returns null for an empty spec with no source", () => {
  assert.equal(parseShard("", ""), null);
});

test("parseShard: throws when a source is set but the spec is empty", () => {
  assert.throws(() => parseShard("", "BROWSER_TEST_SHARD"), /Missing BROWSER_TEST_SHARD value/u);
});

test("parseShard: rejects malformed or out-of-range specs", () => {
  assert.throws(() => parseShard("abc", "--shard"), /Invalid --shard value/u);
  assert.throws(() => parseShard("0/2", "--shard"), /Invalid --shard value/u);
  assert.throws(() => parseShard("3/2", "--shard"), /Invalid --shard value/u);
  assert.throws(() => parseShard("2/0", "--shard"), /Invalid --shard value/u);
});

test("discoverTestFiles: returns the requested files unchanged when given any", () => {
  const requested = ["/a/one.browser.test.js"];
  assert.deepEqual(discoverTestFiles(requested), requested);
});

test("discoverTestFiles: real discovery matches what --list would print", () => {
  // Sanity check against the real tests/browser directory: --list prints
  // path.basename(file) for each discovered file, sorted.
  const discovered = discoverTestFiles([]);
  const names = discovered.map((file) => path.basename(file));
  assert.deepEqual(names, names.slice().sort(), "discovery is sorted");
  for (const name of names) {
    assert.ok(name.endsWith(".browser.test.js"), `${name} should match the browser test suffix`);
  }
});

test("--list output matches selectShard applied to real discovery", () => {
  const files = discoverTestFiles([]);
  if (files.length < 2) return; // nothing meaningful to shard in a near-empty checkout
  const shard = { index: 1, total: 2 };
  const shardOne = selectShard(files, shard);
  const shardTwo = selectShard(files, { index: 2, total: 2 });
  const combinedNames = [...shardOne, ...shardTwo].map((file) => path.basename(file)).sort();
  const allNames = files.map((file) => path.basename(file)).sort();
  assert.deepEqual(combinedNames, allNames);
});
