import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { ACCENTS, DEFAULT_ACCENT } from "../src/webapp/accent-palette.mjs";
import { tintBrandMark } from "./brand-mark-assets.mjs";

const sources = [
  "../src/assets/app/root/logo.svg",
  "../design/icon-masters/icon-maskable.svg",
  "../design/icon-masters/apple-touch-icon.svg",
];

for (const source of sources) {
  const svg = fs.readFileSync(new URL(source, import.meta.url), "utf8");
  for (const accent of ACCENTS) {
    test(`${source} pairs both bands for ${accent.value}`, () => {
      const tinted = tintBrandMark(svg, accent);
      if (accent.value === DEFAULT_ACCENT) {
        assert.equal(tinted, svg);
        return;
      }
      assert.ok(tinted.includes(`stroke="${accent.swatch}"`));
      assert.ok(tinted.includes(`stroke="${accent.highlight}"`));
      assert.ok(!tinted.includes("#d9690f"));
      assert.ok(!tinted.includes("#88a9cb"));
      const normalized = tinted.replaceAll(accent.swatch, "#d9690f").replaceAll(accent.highlight, "#88a9cb");
      assert.equal(normalized, svg);
    });
  }
  for (const missing of ["#d9690f", "#88a9cb"]) {
    test(`${source} rejects a missing ${missing} band`, () => {
      assert.throws(() => tintBrandMark(svg.replaceAll(missing, "#000000"), ACCENTS[1]), /both.*bands/);
    });
  }
}
