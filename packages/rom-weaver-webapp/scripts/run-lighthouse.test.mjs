import assert from "node:assert/strict";
import test from "node:test";
import { LIGHTHOUSE_ATTEMPTS, shouldRetryLighthouseAttempt } from "./run-lighthouse.mjs";

test("retries NO_NAVSTART until the bounded attempt limit", () => {
  const report = { runtimeError: { code: "NO_NAVSTART" } };

  assert.equal(shouldRetryLighthouseAttempt(1, report), true);
  assert.equal(shouldRetryLighthouseAttempt(2, report), true);
  assert.equal(shouldRetryLighthouseAttempt(LIGHTHOUSE_ATTEMPTS, report), false);
});

test("does not retry unrelated Lighthouse runtime errors", () => {
  assert.equal(shouldRetryLighthouseAttempt(1, { runtimeError: { code: "PROTOCOL_TIMEOUT" } }), false);
  assert.equal(shouldRetryLighthouseAttempt(1, undefined), false);
});
