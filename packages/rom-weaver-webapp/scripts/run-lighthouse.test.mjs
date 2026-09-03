import assert from "node:assert/strict";
import test from "node:test";
import {
  LIGHTHOUSE_ATTEMPTS,
  LIGHTHOUSE_CONCURRENCY,
  runWithConcurrency,
  shouldRetryLighthouseAttempt,
} from "./run-lighthouse.mjs";

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

test("runs audits with bounded concurrency and preserves task order", async () => {
  let active = 0;
  let maximumActive = 0;
  const tasks = Array.from({ length: 5 }, (_, index) => async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return index;
  });

  assert.deepEqual(await runWithConcurrency(tasks), [0, 1, 2, 3, 4]);
  assert.equal(maximumActive, LIGHTHOUSE_CONCURRENCY);
});
