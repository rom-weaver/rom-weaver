import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { brandMarkAssets } from "./brand-mark-assets.mjs";

test("emits one unchanged logo for every accent", () => {
  const plugin = brandMarkAssets();
  plugin.configResolved({ command: "build" });
  const emitted = [];
  const module = plugin.load.handler.call(
    { emitFile: (asset) => emitted.push(asset) },
    "\0virtual:rom-weaver-brand-marks",
  );
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].source, fs.readFileSync(new URL("../src/assets/app/root/logo.svg", import.meta.url), "utf8"));
  assert.ok(module.includes(JSON.stringify(`./${emitted[0].fileName}`)));
});

for (const channel of ["beta", "nightly", "preview"]) {
  test(`${channel} preserves the fixed logo`, () => {
    const root = new URL("../src/assets/app/root/", import.meta.url);
    assert.equal(
      fs.readFileSync(new URL(`channels/${channel}/logo.svg`, root), "utf8"),
      fs.readFileSync(new URL("logo.svg", root), "utf8"),
    );
  });
}
