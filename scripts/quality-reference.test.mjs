import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runReference, runReferences, verifyFixture } from "./quality-reference.mjs";

const fixture = JSON.parse(
  readFileSync(new URL("./quality-reference-fixture.json", import.meta.url), "utf8"),
);
const payload = () => {
  const bytes = Buffer.alloc(8193);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 13 + (i >> 8)) & 255;
  return bytes;
};

function executeWith(bytes) {
  return (_binary, args) => {
    const output = args[args.indexOf("--output") + 1];
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "payload.bin"), bytes);
    return { status: 0 };
  };
}

test("valid pinned archive and independent generated input hashes", () => {
  assert.ok(verifyFixture(fixture).length > 0);
  assert.equal(runReference({ execute: executeWith(payload()) }).status, "passed");
});

test("corrupt oracle is rejected before candidate execution", () => {
  assert.throws(
    () => verifyFixture({ ...fixture, archiveBase64: "AA==" }),
    /archive hash mismatch/,
  );
  assert.throws(
    () => verifyFixture({ ...fixture, entries: [{ ...fixture.entries[0], sha256: "0" }] }),
    /input hash mismatch/,
  );
});

test("no meaningful fixture is an error", () => {
  assert.throws(() => verifyFixture({ ...fixture, entries: [] }), /empty pinned reference/);
});

test("candidate output corruption fails, restoring valid output passes", () => {
  const corrupted = payload();
  corrupted[4096] ^= 1;
  assert.throws(() => runReference({ execute: executeWith(corrupted) }), /reference mismatch/);
  assert.equal(runReference({ execute: executeWith(payload()) }).status, "passed");
});

test("partial or missing output never passes", () => {
  assert.throws(
    () => runReference({ execute: executeWith(payload().subarray(0, 8192)) }),
    /reference mismatch/,
  );
  assert.throws(() => runReference({ execute: () => ({ status: 0 }) }), /extraction missing/);
});

test("candidate setup and command failure never count as parity success", () => {
  assert.throws(
    () => runReference({ execute: () => ({ status: 1, stderr: "bad command" }) }),
    /CLI failed: bad command/,
  );
  assert.throws(
    () => runReference({ execute: () => ({ error: new Error("ENOENT") }) }),
    /CLI failed: ENOENT/,
  );
});

test("both frozen formats execute and cannot rewrite their oracle", () => {
  let count = 0;
  let encoderRuns = 0;
  const results = runReferences(
    {
      execute: (binary, args) => {
        count++;
        return executeWith(payload())(binary, args);
      },
    },
    () => {
      encoderRuns++;
      return ["chd", "rvz", "7z"].map((format) => ({ format, status: "passed" }));
    },
  );
  assert.equal(count, 2);
  assert.equal(encoderRuns, 1);
  assert.deepEqual(
    results.map((item) => item.archiveFormat ?? item.format),
    ["zip", "7z", "chd", "rvz", "7z"],
  );
  assert.ok(results.every((item) => item.status === "passed"));
});
test("7z output corruption and unknown fixture formats are rejected", () => {
  const seven = JSON.parse(
    readFileSync(new URL("./quality-reference-7z-fixture.json", import.meta.url), "utf8"),
  );
  const bytes = payload();
  bytes[4096] ^= 1;
  assert.throws(
    () => runReference({ fixture: seven, execute: executeWith(bytes) }),
    /reference mismatch/,
  );
  assert.equal(runReference({ fixture: seven, execute: executeWith(payload()) }).status, "passed");
  assert.throws(() => verifyFixture({ ...seven, archiveFormat: "unknown" }), /unsupported/);
});
