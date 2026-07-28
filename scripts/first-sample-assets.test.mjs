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

// The guides and the CLI guide walk readers through weaving `first-weave.zip`
// and print this digest as the proof their install works. It is only a
// screenshot of whatever the generator happens to emit, so without this test a
// change to the sample ROMs silently publishes a wrong value on three pages.
const DOCUMENTED_WEAVE_SHA256 = "e0db7cbd02cccd5e83931e7974db94aaafe40327b2a33fdd4c83235c9880a90e";
const DOCS_PUBLISHING_THE_DIGEST = [
  "docs/hosting/cli.md",
  "docs/usage/README.md",
  "docs/usage/apply-rom-patches.md",
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
    ["rom-weaver-bundle.json", "hello-world.nes", "hello-to-modified.ips", "world-to-rom.ips"],
  );
  assert.equal(createEntries.get("hello-world.nes")?.subarray(0, 4).toString("hex"), "4e45531a");
  assert.deepEqual(createEntries.get("hello-world.nes"), assets.originalRom);
  assert.deepEqual(createEntries.get("modified-world.nes"), assets.modifiedRom);
  assert.deepEqual(
    applyIps(assets.originalRom, weaveEntries.get("hello-to-modified.ips")),
    assets.modifiedRom,
  );
  assert.deepEqual(applyIps(assets.modifiedRom, weaveEntries.get("world-to-rom.ips")), assets.wovenRom);

  const manifest = JSON.parse(weaveEntries.get("rom-weaver-bundle.json"));
  assert.equal(manifest.rom.path, "hello-world.nes");
  assert.deepEqual(
    manifest.patches.map((patch) => patch.path),
    ["hello-to-modified.ips", "world-to-rom.ips"],
  );
  assert.deepEqual(manifest.patches[0].outputChecks, manifest.patches[1].inputChecks);
  assert.equal(manifest.output.name, "modified-rom.nes");

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
  // bundle's two IPS patches applied in order, which the round-trip test above
  // pins to `wovenRom`.
  const digest = createHash("sha256").update(assets.wovenRom).digest("hex");

  assert.equal(digest, DOCUMENTED_WEAVE_SHA256);

  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  for (const file of DOCS_PUBLISHING_THE_DIGEST) {
    const markdown = fs.readFileSync(path.join(repositoryRoot, file), "utf8");
    assert.ok(markdown.includes(digest), `${file} no longer publishes ${digest}`);
  }
});
