import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DOCS_SCREENSHOT_CASES, waitForDocsScreenshotReady } from "./docs-screenshot-manifest.mjs";

test("guided captures wait for loaded sample data independently of tutorial copy", async () => {
  const calls = [];
  const page = {
    locator: (selector) => {
      const locator = {
        click: async () => calls.push([selector, "click"]),
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
      ...(captureCase.practiceFiles ? [[".sample-tutorial-actions .btn.primary", "click"]] : []),
      [captureCase.target, "visible"],
    ]);
    assert.equal("waitFor" in captureCase, false);
  }
  assert.equal(DOCS_SCREENSHOT_CASES.length, 10);
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

test("the weave guide teaches current controls without the obsolete Bundle screenshot", () => {
  const guide = readFileSync(new URL("../../../docs/how-to/create-bundles.md", import.meta.url), "utf8");
  const capture = DOCS_SCREENSHOT_CASES.find(({ name }) => name === "bundle-output");
  assert.ok(capture, "keep the capture recipe for the next screenshot refresh");
  assert.equal(capture.route, "/weave-patches?guide=weave");
  assert.equal(capture.target, "#rom-weaver-weave-job");
  assert.equal(capture.docsRoute, undefined);
  assert.ok(!guide.includes("../screenshots/bundle-output-"), "do not publish the obsolete instructional image");
  assert.ok(guide.includes("In the main **Weave** output step"));
  assert.ok(guide.includes("https://rom-weaver.com/apply-patches?weave="));
});
