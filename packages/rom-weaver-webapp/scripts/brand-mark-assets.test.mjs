import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { ACCENTS } from "../src/webapp/accent-palette.mjs";
import { tintBrandMark } from "./brand-mark-assets.mjs";

const logo = fs.readFileSync(new URL("../src/assets/app/root/logo.svg", import.meta.url), "utf8");

test("rejects a source missing the accent tab", () => {
  assert.throws(() => tintBrandMark(logo.replaceAll("#d9690f", "#000000"), ACCENTS[1]), /missing the accent tab/);
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
