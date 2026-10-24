import assert from "node:assert/strict";
import { test } from "node:test";
import { createGuidedLoadingAudit } from "./guided-loading-audit.mjs";

const createHarness = async (scan) => {
  let handler;
  const patterns = [];
  const waits = [];
  const continued = [];
  const context = {
    route: async (pattern, callback) => {
      patterns.push(pattern);
      handler = callback;
    },
  };
  const page = {
    locator: (selector) => ({ waitFor: async (options) => waits.push({ selector, ...options }) }),
  };
  const run = await createGuidedLoadingAudit(context, scan);
  const request = (name) =>
    handler({
      continue: async () => continued.push(name),
      request: () => ({ url: () => `https://example.com/app/${name}` }),
    });
  return { continued, page, patterns, request, run, waits };
};

test("holds loading samples across successive workflows without changing interception", async () => {
  let harness;
  /** @type {Promise<unknown>} */
  let pending;
  const labels = [];
  harness = await createHarness(async (page, label) => {
    assert.equal(page, harness.page);
    assert.deepEqual(harness.continued, labels);
    labels.push(label);
  });
  for (const name of ["first-weave.zip", "hello-world.nes", "modified-world.nes"]) {
    await harness.run(harness.page, [name], name, async () => {
      pending = harness.request(name);
    });
    await pending;
    assert.deepEqual(harness.continued, labels);
  }
  assert.deepEqual(harness.patterns, ["**/{first-weave.zip,hello-world.nes,modified-world.nes}"]);
  assert.deepEqual(
    harness.waits,
    labels.map(() => ({ selector: '.sample-tutorial-dialog[data-loading="true"]', state: "visible" })),
  );
});

test("passes samples through outside audits and holds only the current workflow's samples", async () => {
  let harness;
  /** @type {Promise<unknown>} */
  let pending;
  harness = await createHarness(async () => {
    assert.deepEqual(harness.continued, ["first-weave.zip", "first-weave.zip"]);
  });
  await harness.request("first-weave.zip");
  await harness.run(harness.page, ["hello-world.nes"], "Create", async () => {
    await harness.request("first-weave.zip");
    pending = harness.request("hello-world.nes");
  });
  await pending;
  assert.deepEqual(harness.continued, ["first-weave.zip", "first-weave.zip", "hello-world.nes"]);
});

test("releases held requests after a failed scan and allows the next audit", async () => {
  let fail = true;
  const error = new Error("accessibility violation");
  const harness = await createHarness(async () => {
    if (fail) throw error;
  });
  /** @type {Promise<unknown>} */
  let pending;
  const start = async () => {
    pending = harness.request("first-weave.zip");
  };
  await assert.rejects(harness.run(harness.page, ["first-weave.zip"], "Apply", start), (caught) => caught === error);
  await pending;
  assert.deepEqual(harness.continued, ["first-weave.zip"]);
  fail = false;
  await harness.run(harness.page, ["first-weave.zip"], "Weave", start);
  await pending;
  assert.deepEqual(harness.continued, ["first-weave.zip", "first-weave.zip"]);
});
