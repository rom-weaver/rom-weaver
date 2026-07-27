import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import {
  createFirstSampleAssets,
  writeFirstSampleAssets,
} from "../packages/rom-weaver-webapp/scripts/first-sample-assets.mjs";

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
    ["rom-weaver-bundle.json", "hello-world.nes", "first-weave.ips"],
  );
  assert.equal(createEntries.get("hello-world.nes")?.subarray(0, 4).toString("hex"), "4e45531a");
  assert.deepEqual(createEntries.get("hello-world.nes"), assets.originalRom);
  assert.deepEqual(createEntries.get("modified-world.nes"), assets.modifiedRom);
  assert.deepEqual(
    applyIps(assets.originalRom, weaveEntries.get("first-weave.ips")),
    assets.modifiedRom,
  );

  const manifest = JSON.parse(weaveEntries.get("rom-weaver-bundle.json"));
  assert.equal(manifest.rom.path, "hello-world.nes");
  assert.equal(manifest.output.name, "modified-world.nes");

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
