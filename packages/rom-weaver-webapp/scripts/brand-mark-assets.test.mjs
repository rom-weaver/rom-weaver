import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { ACCENTS } from "../src/webapp/accent-palette.mjs";
import { tintBrandMark } from "../src/webapp/brand-mark-assets.mjs";

const logo = fs.readFileSync(new URL("../src/assets/app/root/logo.svg", import.meta.url), "utf8");
const generatedAssets = new URL("../../../dist/generated-assets/", import.meta.url);

test("rejects a source missing the accent color", () => {
  assert.throws(() => tintBrandMark(logo.replaceAll("#d9690f", "#000000"), ACCENTS[1]), /missing the accent color/);
});

for (const [channel, accentName] of Object.entries({
  production: "madder",
  beta: "woad",
  nightly: "verdigris",
  preview: "plum",
})) {
  test(`${channel} matches its default accent`, () => {
    const accent = ACCENTS.find((entry) => entry.value === accentName);
    const source = fs.readFileSync(new URL(`channel-icons/${channel}/logo.svg`, generatedAssets), "utf8");
    assert.equal(source, tintBrandMark(logo, accent));
  });
}

for (const accent of ACCENTS) {
  test(`${accent.value} reusable logo matches its accent`, () => {
    const source = fs.readFileSync(new URL(`logo-variants/${accent.value}.svg`, generatedAssets), "utf8");
    assert.equal(source, tintBrandMark(logo, accent));
  });
}
