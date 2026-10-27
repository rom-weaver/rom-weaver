import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertJourneyBytes,
  captureConsoleTail,
  downloadedBytes,
  makeJourneyInputs,
} from "./production-workflow-journeys.mjs";

test("roundtrip oracle rejects a single changed byte and truncation", () => {
  const { original, modified } = makeJourneyInputs();
  assertJourneyBytes(Buffer.from(original), original, "exact copy");
  const corrupted = Buffer.from(original);
  corrupted[2048] ^= 1;
  assert.throws(() => assertJourneyBytes(corrupted, original, "corrupted"), /downloaded bytes differ/);
  assert.throws(() => assertJourneyBytes(original.subarray(0, -1), original, "truncated"), /downloaded bytes differ/);
  assert.throws(() => assertJourneyBytes(original, modified, "unpatched"), /downloaded bytes differ/);
});

const downloadPage = () => {
  const download = Promise.withResolvers();
  const listeners = new Map();
  const page = {
    locator: () => ({ innerText: async () => "Apply & download", evaluateAll: async () => [] }),
    on: (event, listener) => listeners.set(event, listener),
    waitForEvent: () => download.promise,
  };
  captureConsoleTail(page);
  return {
    download,
    page,
    consoleMessage: (text) => listeners.get("console")({ type: () => "debug", text: () => text }),
  };
};

test("a download timeout distinguishes a pending click from a completed click", async () => {
  for (const completed of [false, true]) {
    const { download, page } = downloadPage();
    const action = Promise.withResolvers();
    const result = downloadedBytes(page, () => action.promise);
    if (completed) {
      action.resolve();
      await action.promise;
    }
    download.reject(new Error("download timeout"));
    try {
      await assert.rejects(result, new RegExp(`Trigger action: ${completed ? "completed" : "pending"}`));
    } finally {
      action.resolve();
    }
  }
});

test("download diagnostics preserve the trigger failure", async () => {
  const { download, page } = downloadPage();
  const cause = new Error("click intercepted by overlay");
  try {
    await assert.rejects(
      downloadedBytes(page, async () => {
        throw cause;
      }),
      (error) => error.message.includes("Trigger action: failed") && error.cause === cause,
    );
  } finally {
    download.resolve();
  }
});

test("WASM noise cannot evict the Apply action history", async () => {
  const { consoleMessage, download, page } = downloadPage();
  consoleMessage("ui:apply-session: apply primary action queued: patch change pending");
  for (let index = 0; index < 300; index++) consoleMessage(`wasm trace ${index}`);
  const result = downloadedBytes(page, async () => undefined);
  download.reject(new Error("download timeout"));
  await assert.rejects(
    result,
    (error) =>
      error.message.includes("apply primary action queued: patch change pending") &&
      error.message.includes("wasm trace 299"),
  );
});
