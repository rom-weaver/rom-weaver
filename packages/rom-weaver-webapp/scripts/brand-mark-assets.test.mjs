import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { ACCENTS } from "../src/webapp/accent-palette.mjs";
import {
  BRAND_MARK_TONE_COLORS,
  BRAND_MARK_TONES,
  BRAND_MARK_TIGHT_VIEWBOX,
  renderBrandMark,
} from "../src/webapp/brand-mark-assets.mjs";

const logo = fs.readFileSync(new URL("../design/icon-masters/brand-mark.svg", import.meta.url), "utf8");
const repositoryRenders = new URL("../design/icon-masters/renders/", import.meta.url);
const generatedAssets = new URL("../../../dist/generated-assets/", import.meta.url);

test("the canonical master has geometry but no palette or background", () => {
  assert.match(logo, /class="brand-mark-cartridge"/);
  assert.match(logo, /class="brand-mark-accent"/);
  assert.doesNotMatch(logo, /#[0-9a-f]{6}/i);
  assert.doesNotMatch(logo, /<rect|<g\b/);
});

test("rejects a source missing the accent shape", () => {
  assert.throws(
    () => renderBrandMark(logo.replace('class="brand-mark-accent"', 'class="missing-accent"'), ACCENTS[1]),
    /missing the accent shape/,
  );
});

test("responsive logo switches between dark and light tones", () => {
  const rendered = renderBrandMark(logo, { accent: ACCENTS[0] });
  assert.match(rendered, new RegExp(`--brand-cartridge: ${BRAND_MARK_TONE_COLORS.dark}`));
  assert.match(rendered, new RegExp(`--brand-cartridge: ${BRAND_MARK_TONE_COLORS.light}`));
});

test("repository renders contain only explicit logo tones", () => {
  assert.deepEqual(fs.readdirSync(repositoryRenders).sort(), [...BRAND_MARK_TONES].sort());
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
    assert.equal(source, renderBrandMark(logo, { accent, viewBox: BRAND_MARK_TIGHT_VIEWBOX }));
  });
}

for (const accent of ACCENTS) {
  for (const tone of BRAND_MARK_TONES) {
    test(`${accent.value} ${tone} logo uses the ${tone} cartridge`, () => {
      const expected = renderBrandMark(logo, { accent, tone, viewBox: BRAND_MARK_TIGHT_VIEWBOX });
      const rendered = fs.readFileSync(new URL(`${tone}/${accent.value}.svg`, repositoryRenders), "utf8");
      const generated = fs.readFileSync(new URL(`logo-variants/${tone}/${accent.value}.svg`, generatedAssets), "utf8");
      assert.equal(rendered, expected);
      assert.equal(generated, rendered);
      assert.match(rendered, new RegExp(`fill="${BRAND_MARK_TONE_COLORS[tone]}"`));
      assert.match(rendered, new RegExp(`fill="${accent.swatch}"`));
      assert.doesNotMatch(rendered, /<rect|<g\b/);
    });
  }
}
