import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildIdentifyReleaseData } from "./build-identify-release-data.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const fixture = () => {
  const root = mkdtempSync(join(os.tmpdir(), "rw-identify-release-"));
  const input = join(root, "input");
  mkdirSync(input);
  const packs = [
    ["zeta", Buffer.from("RWFP1 zeta fixture")],
    ["alpha", Buffer.from("RWFP2 alpha fixture")],
  ];
  const systems = packs.map(([slug, bytes]) => {
    const file = `${slug}.pack`;
    writeFileSync(join(input, file), bytes);
    return {
      file,
      platform: slug,
      rawBytes: bytes.length,
      sha256: sha256(bytes),
      slug,
      source: "fixture",
    };
  });
  writeFileSync(join(input, "index.json"), `${JSON.stringify({ format: "fixture", systems })}\n`);
  writeFileSync(join(input, "catalog.json"), '{"format":"fixture-catalog"}\n');
  return { input, root };
};

test("builds deterministic Zstandard packs and a stable release archive", () => {
  const { input, root } = fixture();
  const first = buildIdentifyReleaseData({
    archive: join(root, "first.tar.zst"),
    input,
    out: join(root, "first"),
  });
  const second = buildIdentifyReleaseData({
    archive: join(root, "second.tar.zst"),
    input,
    out: join(root, "second"),
  });
  assert.deepEqual(readFileSync(first.archive), readFileSync(second.archive));

  const index = JSON.parse(readFileSync(join(first.dataDir, "index.json"), "utf8"));
  assert.deepEqual(
    index.systems.map((system) => system.slug),
    ["alpha", "zeta"],
  );
  for (const system of index.systems) {
    assert.equal(system.zstdFile, `packs/${system.slug}.pack.zst`);
    const compressed = readFileSync(join(first.dataDir, system.zstdFile));
    assert.equal(system.zstdBytes, compressed.length);
    assert.equal(system.zstdSha256, sha256(compressed));
  }
});

test("rejects a raw pack that does not match its index integrity fields", () => {
  const { input, root } = fixture();
  writeFileSync(join(input, "alpha.pack"), "tampered");
  assert.throws(
    () =>
      buildIdentifyReleaseData({
        archive: join(root, "data.tar.zst"),
        input,
        out: join(root, "out"),
      }),
    /does not match index\.json/u,
  );
});
