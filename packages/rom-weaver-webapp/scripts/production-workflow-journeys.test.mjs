import assert from "node:assert/strict";
import { test } from "node:test";
import { assertJourneyBytes, makeJourneyInputs } from "./production-workflow-journeys.mjs";

test("roundtrip oracle rejects a single changed byte and truncation", () => {
  const { original, modified } = makeJourneyInputs();
  assertJourneyBytes(Buffer.from(original), original, "exact copy");
  const corrupted = Buffer.from(original);
  corrupted[2048] ^= 1;
  assert.throws(() => assertJourneyBytes(corrupted, original, "corrupted"), /downloaded bytes differ/);
  assert.throws(() => assertJourneyBytes(original.subarray(0, -1), original, "truncated"), /downloaded bytes differ/);
  assert.throws(() => assertJourneyBytes(original, modified, "unpatched"), /downloaded bytes differ/);
});
