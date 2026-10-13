import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), "utf8");

// The agent smoke driver is not run in CI, so it went stale when Apply moved off
// the site root. Keep its route and file picker tied to the app and the journeys.
test("run-rom-weaver webapp driver opens the Apply route and its file picker", () => {
  const driver = read("../../../.agents/skills/run-rom-weaver/webapp-driver.mjs");
  const controller = read("../src/webapp/webapp-controller.ts");
  const journeys = read("./production-workflow-journeys.mjs");

  const route = driver.match(/new URL\("([^"]+)", BASE_URL/)?.[1];
  assert.equal(route, "apply-patches");
  assert.match(controller, new RegExp(`"${route}": "patcher"`));

  const pickerIds = [...driver.matchAll(/locator\("#([\w-]+)"\)/g)].map((match) => match[1]);
  assert.ok(pickerIds.length > 0);
  for (const pickerId of new Set(pickerIds)) {
    assert.match(journeys, new RegExp(`openWorkflow\\(page, baseUrl, "${route}", "${pickerId}"\\)`));
  }
});
