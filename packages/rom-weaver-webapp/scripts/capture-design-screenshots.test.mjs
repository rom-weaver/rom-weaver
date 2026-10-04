import assert from "node:assert/strict";
import { test } from "node:test";
import { DOCS_SCREENSHOT_CASES, waitForDocsScreenshotReady } from "./docs-screenshot-manifest.mjs";

test("guided captures wait for loaded sample data independently of tutorial copy", async () => {
  const calls = [];
  const page = {
    locator: (selector) => {
      const locator = {
        first: () => locator,
        waitFor: async (options) => calls.push([selector, options.state]),
      };
      return locator;
    },
  };
  for (const captureCase of DOCS_SCREENSHOT_CASES) {
    calls.length = 0;
    await waitForDocsScreenshotReady(page, captureCase);
    assert.deepEqual(calls, [
      ["body", "visible"],
      ...(captureCase.dismissGuide ? [['.sample-tutorial-dialog[aria-busy="false"]', "visible"]] : []),
      [captureCase.target, "visible"],
    ]);
    assert.equal("waitFor" in captureCase, false);
  }
  assert.equal(DOCS_SCREENSHOT_CASES.length, 9);
});

test("a loading tutorial cannot advance to target capture", async () => {
  const loadingError = new Error("sample still loading");
  const calls = [];
  const page = {
    locator: (selector) => ({
      waitFor: async () => {
        calls.push(selector);
        if (selector.includes("aria-busy")) throw loadingError;
      },
    }),
  };
  await assert.rejects(waitForDocsScreenshotReady(page, DOCS_SCREENSHOT_CASES[2]), (error) => error === loadingError);
  assert.deepEqual(calls, ["body", '.sample-tutorial-dialog[aria-busy="false"]']);
});

test("a ready tutorial still requires its loaded capture target", async () => {
  const missingTarget = new Error("loaded target missing");
  const captureCase = DOCS_SCREENSHOT_CASES[2];
  const page = {
    locator: (selector) => {
      const locator = {
        first: () => locator,
        waitFor: async () => {
          if (selector === captureCase.target) throw missingTarget;
        },
      };
      return locator;
    },
  };
  await assert.rejects(waitForDocsScreenshotReady(page, captureCase), (error) => error === missingTarget);
});
