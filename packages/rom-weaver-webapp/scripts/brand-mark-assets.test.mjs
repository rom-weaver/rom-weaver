import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const logo = fs.readFileSync(new URL("../src/assets/app/root/logo.png", import.meta.url));
const generatedAssets = new URL("../../../dist/generated-assets/", import.meta.url);

for (const channel of ["production", "beta", "nightly", "preview"]) {
  test(`${channel} logo matches the source PNG bytes`, () => {
    const generated = fs.readFileSync(new URL(`channel-icons/${channel}/logo.png`, generatedAssets));
    assert.deepEqual(generated, logo);
  });
}
