import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { trackedFiles } from "../lint-tracked.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("icon consumers in CI select the installed system Chrome", () => {
  const paths = trackedFiles(root, [".github/workflows/*.yml", ".github/actions/*/action.yml"]);
  let consumers = 0;
  for (const path of paths) {
    const source = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
    const steps = source.split(/(?=^\s+- (?:name|uses|run):)/m);
    for (const step of steps) {
      if (!/npm --prefix packages\/rom-weaver-webapp run (?:build|analyze|icons:channels(?::check)?|test:scripts|test:browser)(?:\s|$)/.test(step)) continue;
      consumers += 1;
      assert.match(step, /ROM_WEAVER_SYSTEM_CHROME: "1"/, `${path}: icon generation needs the runner's browser`);
    }
  }
  assert.ok(consumers > 0, "no icon consumers found; the workflow matcher needs updating");
});
