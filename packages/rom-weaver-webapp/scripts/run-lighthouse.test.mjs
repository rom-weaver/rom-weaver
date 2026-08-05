import assert from "node:assert/strict";
import test from "node:test";
import { LIGHTHOUSE_ATTEMPTS, shouldRetryLighthouse } from "./run-lighthouse.mjs";

test("retries NO_NAVSTART until the bounded attempt limit", () => {
  const report = { runtimeError: { code: "NO_NAVSTART" } };

  assert.equal(shouldRetryLighthouse(1, report), true);
  assert.equal(shouldRetryLighthouse(2, report), true);
  assert.equal(shouldRetryLighthouse(LIGHTHOUSE_ATTEMPTS, report), false);
});

test("does not retry unrelated Lighthouse runtime errors", () => {
  assert.equal(shouldRetryLighthouse(1, { runtimeError: { code: "PROTOCOL_TIMEOUT" } }), false);
  assert.equal(shouldRetryLighthouse(1, undefined), false);
});
