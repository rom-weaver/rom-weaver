import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { ACCENTS } from "../src/webapp/accent-palette.mjs";
import {
  BRAND_MARK_TONE_COLORS,
  BRAND_MARK_TONES,
  BRAND_MARK_FAVICON_VIEWBOX,
  BRAND_MARK_TIGHT_VIEWBOX,
  renderBrandMark,
  renderFavicon,
} from "../src/webapp/brand-mark-assets.mjs";

const logo = fs.readFileSync(new URL("../design/icon-masters/brand-mark.svg", import.meta.url), "utf8");
const repositoryRenders = new URL("../design/icon-masters/renders/", import.meta.url);
const generatedAssets = new URL("../../../dist/generated-assets/", import.meta.url);

test("the adaptive favicon has PNG and ICO fallbacks", () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const icons = [...html.matchAll(/<link\b[^>]*>/g)]
    .map(([link]) => link)
    .filter((link) => /rel="(?:alternate )?icon"/.test(link));
  assert.equal(icons.length, 3);
  assert.match(icons[0], /href="\.\/favicon\.svg"/);
  assert.match(icons[0], /data-favicon/);
  assert.doesNotMatch(icons[0], /media=/);
  assert.match(icons[1], /href="\.\/favicon-32x32\.png"/);
  assert.match(icons[1], /sizes="32x32"/);
  assert.match(icons[2], /href="\.\/favicon\.ico"/);
  assert.match(icons[2], /sizes="any"/);
});

test("favicons preserve the mark with 5–12% padding", () => {
  assert.equal(BRAND_MARK_TIGHT_VIEWBOX, "8 4 48 56");
  assert.equal(BRAND_MARK_FAVICON_VIEWBOX, "0.8889 0.8889 62.2222 62.2222");
});

test("the app manifest separates regular and maskable icons", () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../src/assets/app/root/manifest.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(manifest.icons, [
    { purpose: "any", sizes: "192x192", src: "icon-192.png", type: "image/png" },
    { purpose: "any", sizes: "512x512", src: "icon-512.png", type: "image/png" },
    { purpose: "maskable", sizes: "512x512", src: "icon-maskable-512.png", type: "image/png" },
  ]);
});

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
    const favicon = fs.readFileSync(new URL(`channel-icons/${channel}/favicon.svg`, generatedAssets), "utf8");
    assert.equal(favicon, renderFavicon(logo, { accent }));
    assert.match(favicon, /width="64" height="64"/);
    assert.doesNotMatch(favicon, /preserveAspectRatio="none"/);
    assert.match(favicon, /@media \(prefers-color-scheme: dark\)/);
    assert.doesNotMatch(favicon, /<rect|<g\b/);
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
