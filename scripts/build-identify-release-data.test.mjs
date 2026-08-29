import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { brotliCompressSync } from "node:zlib";
import { join } from "node:path";
import test from "node:test";
import { buildIdentifyReleaseData } from "./build-identify-release-data.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const fixture = ({ grouped = false } = {}) => {
  const root = mkdtempSync(join(os.tmpdir(), "rw-identify-release-"));
  const input = join(root, "input");
  mkdirSync(input);
  const packs = [
    ["zeta", Buffer.from("RWFP4 zeta fixture")],
    ["alpha", Buffer.from("RWFP4 alpha fixture")],
  ];
  const systems = packs.map(([slug, bytes]) => {
    const file = `${slug}.pack`;
    writeFileSync(join(input, file), bytes);
    writeFileSync(join(input, `${file}.br`), brotliCompressSync(bytes));
    return {
      file,
      platform: slug,
      rawBytes: bytes.length,
      sha256: sha256(bytes),
      slug,
      source: "fixture",
    };
  });
  const groups = grouped
    ? [
        { default: true, id: "core", label: "Core", systems: ["alpha"] },
        {
          default: false,
          id: "optional-computers",
          label: "Computers",
          systems: ["zeta"],
        },
      ]
    : undefined;
  writeFileSync(
    join(input, "index.json"),
    `${JSON.stringify({ format: "fixture", groups, systems })}\n`,
  );
  writeFileSync(
    join(input, "catalog.json"),
    `${JSON.stringify({ format: "fixture-catalog", platforms: systems.map((entry) => ({ packSlug: entry.slug })) })}\n`,
  );
  return { input, root };
};

test("builds deterministic Brotli packs and a stable release archive", () => {
  const { input, root } = fixture();
  const first = buildIdentifyReleaseData({
    archive: join(root, "first.tar.br"),
    input,
    out: join(root, "first"),
  });
  const second = buildIdentifyReleaseData({
    archive: join(root, "second.tar.br"),
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
    assert.equal(system.brotliFile, `packs/${system.slug}.pack.br`);
    const compressed = readFileSync(join(first.dataDir, system.brotliFile));
    assert.equal(system.brotliBytes, compressed.length);
    assert.equal(system.brotliSha256, sha256(compressed));
  }
});

test("creates a missing release archive directory", () => {
  const { input, root } = fixture();
  const archive = join(root, "target", "rom-weaver-identify-data.tar.br");
  const result = buildIdentifyReleaseData({
    archive,
    input,
    out: join(root, "release"),
  });
  assert.equal(result.archive, archive);
  assert.ok(readFileSync(archive).length > 0);
});

test("separates default packs from complete optional group archives", () => {
  const { input, root } = fixture({ grouped: true });
  const result = buildIdentifyReleaseData({
    archive: join(root, "rom-weaver-identify-data.tar.br"),
    input,
    out: join(root, "release"),
  });
  assert.deepEqual(
    JSON.parse(readFileSync(join(result.dataDir, "index.json"), "utf8")).systems.map(
      ({ slug }) => slug,
    ),
    ["alpha"],
  );
  assert.equal(result.optional.length, 1);
  assert.equal(result.optional[0].group, "optional-computers");
  const optionalIndex = JSON.parse(
    readFileSync(join(result.optional[0].dataDir, "index.json"), "utf8"),
  );
  assert.deepEqual(
    optionalIndex.systems.map(({ slug }) => slug),
    ["zeta"],
  );
  assert.deepEqual(
    optionalIndex.groups.map(({ id }) => id),
    ["optional-computers"],
  );
});

test("rejects a raw pack that does not match its index integrity fields", () => {
  const { input, root } = fixture();
  writeFileSync(join(input, "alpha.pack"), "tampered");
  assert.throws(
    () =>
      buildIdentifyReleaseData({
        archive: join(root, "data.tar.br"),
        input,
        out: join(root, "out"),
      }),
    /does not match index\.json/u,
  );
});

test("rejects a Brotli sidecar that does not match its raw pack", () => {
  const { input, root } = fixture();
  writeFileSync(join(input, "alpha.pack.br"), brotliCompressSync(Buffer.from("tampered")));
  assert.throws(
    () =>
      buildIdentifyReleaseData({
        archive: join(root, "data.tar.br"),
        input,
        out: join(root, "out"),
      }),
    /does not match alpha\.pack/u,
  );
});
