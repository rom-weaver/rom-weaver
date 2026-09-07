import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { ACCENTS } from "../src/webapp/accent-palette.mjs";
import { brandMarkAssets, tintBrandMark } from "./brand-mark-assets.mjs";

const logo = fs.readFileSync(new URL("../src/assets/app/root/logo.svg", import.meta.url), "utf8");

test("emits each accent while preserving the cream band and geometry", () => {
  const plugin = brandMarkAssets();
  plugin.configResolved({ command: "build" });
  const emitted = [];
  const module = plugin.load.handler.call(
    { emitFile: (asset) => emitted.push(asset) },
    "\0virtual:rom-weaver-brand-marks",
  );
  assert.equal(emitted.length, ACCENTS.length);
  for (const [index, accent] of ACCENTS.entries()) {
    const asset = emitted[index];
    assert.ok(module.includes(JSON.stringify(`./${asset.fileName}`)));
    assert.ok(asset.source.includes(`stroke="${accent.swatch}"`));
    assert.ok(asset.source.includes('stroke="#f6ecda" stroke-width="5"'));
    assert.ok(!asset.source.includes("#88a9cb"));
    assert.equal(asset.source.replaceAll(accent.swatch, "#d9690f"), logo);
  }
});

test("rejects a source missing the accent band", () => {
  assert.throws(() => tintBrandMark(logo.replaceAll("#d9690f", "#000000"), ACCENTS[1]), /missing the accent band/);
});

for (const [channel, accentName] of Object.entries({ beta: "woad", nightly: "verdigris", preview: "plum" })) {
  test(`${channel} matches its default accent`, () => {
    const accent = ACCENTS.find((entry) => entry.value === accentName);
    const source = fs.readFileSync(
      new URL(`../src/assets/app/root/channels/${channel}/logo.svg`, import.meta.url),
      "utf8",
    );
    assert.equal(source, tintBrandMark(logo, accent));
  });
}
