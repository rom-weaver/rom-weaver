import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  canonicalPayloads,
  generatedInput,
  runEncoderReferences,
} from "./quality-reference-encoder.mjs";
const fixtures = JSON.parse(
  fs.readFileSync(new URL("./quality-reference-encoder.json", import.meta.url)),
);
const fake =
  (corrupt = false) =>
  (_bin, args) => {
    const format = args[args.indexOf("--format") + 1];
    const bytes = Buffer.from(
      fixtures.find((fixture) => fixture.format === format).archiveBase64,
      "base64",
    );
    if (corrupt) bytes[format === "rvz" ? 32785 : format === "chd" ? 180 : 50] ^= 1;
    fs.writeFileSync(args[args.indexOf("--output") + 1], bytes);
    return { status: 0 };
  };
test("three meaningful independent frozen encoder oracles pass", () => {
  const result = runEncoderReferences({ execute: fake() });
  assert.deepEqual(
    result.map((item) => item.format),
    ["chd", "rvz", "7z"],
  );
  assert.deepEqual(
    result.map((item) => item.compressedPayloadSha256.length),
    [1, 3, 1],
  );
});
test("corrupted candidate fails; restored candidate passes", () => {
  for (const format of ["chd", "rvz", "7z"]) {
    const runner = fake(true),
      valid = fake();
    assert.throws(
      () =>
        runEncoderReferences({
          execute: (bin, args) => (args.includes(format) ? runner(bin, args) : valid(bin, args)),
        }),
      /reference mismatch/,
    );
  }
  assert.equal(runEncoderReferences({ execute: fake() }).length, 3);
});
test("oracle and input hashes are checked before candidate runs", () => {
  for (const field of ["inputSha256", "archiveSha256"]) {
    const changed = structuredClone(fixtures);
    changed[0][field] = "bad";
    assert.throws(
      () =>
        runEncoderReferences({ fixtures: changed, execute: () => assert.fail("must not execute") }),
      /oracle hash mismatch/,
    );
  }
});
test("failed command, timeout, missing output and zero signals fail", () => {
  for (const result of [{ status: 1 }, { status: null, error: new Error("timeout") }])
    assert.throws(() => runEncoderReferences({ execute: () => result }), /CLI failed/);
  assert.throws(() => runEncoderReferences({ execute: () => ({ status: 0 }) }), /ENOENT/);
  assert.throws(() => runEncoderReferences({ fixtures: [] }), /missing encoder/);
});
test("bounded canonical extraction rejects malformed signatures and offsets", () => {
  for (const fixture of fixtures) {
    const bytes = Buffer.from(fixture.archiveBase64, "base64");
    assert.ok(canonicalPayloads(fixture.format, bytes).every((part) => part.length > 0));
    assert.throws(() => canonicalPayloads(fixture.format, bytes.subarray(0, 12)));
    bytes[0] ^= 1;
    assert.throws(() => canonicalPayloads(fixture.format, bytes));
  }
  const archive = Buffer.from(fixtures[2].archiveBase64, "base64");
  archive.writeBigUInt64LE(0xffffffffffffffffn, 12);
  assert.throws(() => canonicalPayloads("7z", archive), /invalid reference payload range/);
});
test("fixture generators exercise intended sizes and independently fixed disc magic", () => {
  assert.equal(generatedInput("chd").length, 4096);
  assert.equal(generatedInput("7z").length, 8193);
  assert.equal(generatedInput("rvz").readUInt32BE(0x1c), 0xc2339f3d);
});

test("duplicate fixtures cannot silently omit an encoder", () => {
  assert.throws(
    () => runEncoderReferences({ fixtures: [fixtures[0], fixtures[0], fixtures[2]] }),
    /missing encoder/,
  );
});
