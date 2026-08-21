import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import {
  createFirstSampleAssets,
  writeFirstSampleAssets,
} from "../packages/rom-weaver-webapp/scripts/first-sample-assets.mjs";

// Both tutorials walk readers through weaving `first-weave.zip` and print this
// digest as the proof their run worked. It is only a screenshot of whatever the
// generator happens to emit, so without this test a change to the sample ROMs
// silently publishes a wrong value on both pages.
const DOCUMENTED_WEAVE_SHA256 = "7ac8001dcbcbff45cd5cebb5b0655192021fbbdf27533aa961347194ab3e836e";
const DOCS_PUBLISHING_THE_DIGEST = [
  "docs/tutorials/cli-first-weave.md",
  "docs/tutorials/first-patch.md",
];

const readZip = (archive) => {
  const entries = new Map();
  let offset = 0;
  while (archive.readUInt32LE(offset) === 0x04034b50) {
    const method = archive.readUInt16LE(offset + 8);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const name = archive.subarray(offset + 30, offset + 30 + nameLength).toString();
    const dataOffset = offset + 30 + nameLength + extraLength;
    const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
    entries.set(name, method === 8 ? zlib.inflateRawSync(compressed) : compressed);
    offset = dataOffset + compressedSize;
  }
  return entries;
};

const applyIps = (original, patch) => {
  assert.equal(patch.subarray(0, 5).toString(), "PATCH");
  const output = Buffer.from(original);
  let offset = 5;
  while (patch.subarray(offset, offset + 3).toString() !== "EOF") {
    const targetOffset = patch.readUIntBE(offset, 3);
    const size = patch.readUInt16BE(offset + 3);
    patch.copy(output, targetOffset, offset + 5, offset + 5 + size);
    offset += 5 + size;
  }
  return output;
};

test("generated first-create and first-weave archives contain a runnable NES patch round trip", (context) => {
  const assets = createFirstSampleAssets();
  const createEntries = readZip(assets.firstCreateZip);
  const weaveEntries = readZip(assets.firstWeaveZip);

  assert.deepEqual([...createEntries.keys()], ["hello-world.nes", "modified-world.nes"]);
  assert.deepEqual(
    [...weaveEntries.keys()],
    ["rom-weaver-bundle.json", "hello-world.nes", "hello-to-rom.ips", "world-to-weaver.ips"],
  );
  assert.equal(createEntries.get("hello-world.nes")?.subarray(0, 4).toString("hex"), "4e45531a");
  assert.deepEqual(createEntries.get("hello-world.nes"), assets.originalRom);
  assert.deepEqual(createEntries.get("modified-world.nes"), assets.modifiedRom);
  assert.deepEqual(
    applyIps(assets.originalRom, weaveEntries.get("hello-to-rom.ips")),
    assets.firstPatchResult,
  );
  assert.deepEqual(
    applyIps(assets.originalRom, weaveEntries.get("world-to-weaver.ips")),
    assets.secondPatchResult,
  );
  assert.deepEqual(
    applyIps(assets.firstPatchResult, weaveEntries.get("world-to-weaver.ips")),
    assets.wovenRom,
  );
  assert.deepEqual(
    applyIps(assets.secondPatchResult, weaveEntries.get("hello-to-rom.ips")),
    assets.wovenRom,
  );

  const manifest = JSON.parse(weaveEntries.get("rom-weaver-bundle.json"));
  assert.equal(manifest.rom.path, "hello-world.nes");
  assert.deepEqual(
    manifest.patches.map((patch) => patch.path),
    ["hello-to-rom.ips", "world-to-weaver.ips"],
  );
  assert.deepEqual(manifest.patches.map((patch) => patch.basis), ["base", "base"]);
  assert.equal(manifest.patches[0].inputChecks, undefined);
  assert.equal(manifest.patches[1].inputChecks, undefined);
  assert.equal(manifest.patches[0].outputChecks, undefined);
  assert.equal(manifest.patches[1].outputChecks, undefined);
  assert.equal(manifest.output.name, "rom-weaver.nes");

  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rom-weaver-first-samples-"));
  context.after(() => fs.rmSync(outputDirectory, { force: true, recursive: true }));
  writeFirstSampleAssets(outputDirectory);
  assert.deepEqual(
    fs.readFileSync(path.join(outputDirectory, "first-create.zip")),
    assets.firstCreateZip,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(outputDirectory, "first-weave.zip")),
    assets.firstWeaveZip,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(outputDirectory, "hello-world.nes")),
    assets.originalRom,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(outputDirectory, "modified-world.nes")),
    assets.modifiedRom,
  );
});

test("the sample digest the guides publish still matches the generated sample", () => {
  const assets = createFirstSampleAssets();
  // What `rom-weaver weave --input first-weave.zip --no-compress` writes: the
  // The bundle's two base-authored IPS patches apply in either order, which
  // the round-trip test above pins to `wovenRom`.
  const digest = createHash("sha256").update(assets.wovenRom).digest("hex");

  assert.equal(digest, DOCUMENTED_WEAVE_SHA256);

  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  for (const file of DOCS_PUBLISHING_THE_DIGEST) {
    const markdown = fs.readFileSync(path.join(repositoryRoot, file), "utf8");
    assert.ok(markdown.includes(digest), `${file} no longer publishes ${digest}`);
  }
});
