import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { maskVolatileBytes } from "../tests/wasm/patch-create-parity-inputs.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const solidPatch = (date) => {
  const bytes = new Uint8Array(65).fill(0x11);
  bytes.set(date, 0x18);
  return bytes;
};

test("SOLID parity hash ignores the creation date bytes (0x18-0x1a)", () => {
  const today = solidPatch([0x7e, 0x80, 0x99]);
  const tomorrow = solidPatch([0x7f, 0x80, 0x99]);
  assert.notEqual(sha(today), sha(tomorrow));
  assert.equal(sha(maskVolatileBytes("solid", today)), sha(maskVolatileBytes("solid", tomorrow)));
});

test("SOLID masking leaves every other byte significant", () => {
  const base = solidPatch([1, 2, 3]);
  const changed = solidPatch([1, 2, 3]);
  changed[0x1b] ^= 1;
  assert.notEqual(sha(maskVolatileBytes("solid", base)), sha(maskVolatileBytes("solid", changed)));
});

test("other formats are hashed unchanged", () => {
  const bytes = solidPatch([1, 2, 3]);
  assert.equal(maskVolatileBytes("ips32", bytes), bytes);
});
