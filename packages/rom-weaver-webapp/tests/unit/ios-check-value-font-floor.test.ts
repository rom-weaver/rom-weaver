import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * The iOS focus-zoom floor in webapp-modals.css raises every field to 16px, and its
 * layer sits after the one holding the check-value clamp - so without the `.ck-input`
 * opt-out the editable md5/sha-1 rows render at 16px, which no phone is wide enough to
 * fit: the hash clips and the patch card's values dwarf the ROM card's read-only ones.
 *
 * Nothing in CI can catch a regression here. The rule is gated on
 * `@supports (-webkit-touch-callout: none)`, which only real Safari matches - the
 * Chromium and desktop-WebKit suites both resolve it to false - so the pairing is
 * asserted against the source text instead.
 */

const read = (relativePath: string) => readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

const MODALS_CSS = read("../../src/webapp/design-system/webapp-modals.css");
const FIELDS_CSS = read("../../src/webapp/design-system/fields.css");
const DRAWERS_CSS = read("../../src/webapp/design-system/drawers.css");
const PATCH_LIST_STEP = read("../../src/public/react/apply-patch-list-step.tsx");

/** The `@supports (-webkit-touch-callout: none)` block: the iOS-only font-size floor. */
const iosFloorBlock = (): string => {
  const start = MODALS_CSS.indexOf("@supports (-webkit-touch-callout: none)");
  if (start === -1) throw new Error("webapp-modals.css no longer has an iOS -webkit-touch-callout block");
  const end = MODALS_CSS.indexOf("\n}", MODALS_CSS.indexOf("\n  }", start));
  return MODALS_CSS.slice(start, end);
};

/** Every `font-size` selector in the floor block that a check-value `<input>` could match. */
const selectorsMatchingATextInput = (block: string): string[] =>
  [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, , declarations]) => declarations.includes("font-size"))
    .flatMap(([, selectorList]) => selectorList.split(","))
    .map((selector) => selector.replaceAll(/\/\*[^*]*\*+([^/*][^*]*\*+)*\//g, "").trim())
    .filter((selector) => /(^|\s)\.?input(:|$)/.test(selector));

describe("iOS check-value font floor", () => {
  test("the floor exempts .ck-input from every selector a check input matches", () => {
    const selectors = selectorsMatchingATextInput(iosFloorBlock());
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) expect(selector).toContain(":not(.ck-input)");
  });

  test("the editable check row carries .ck-input", () => {
    expect(PATCH_LIST_STEP).toContain('className="input mono popt-input ck-input"');
  });

  test("the exempted field still has a container-derived size to fall back to", () => {
    expect(FIELDS_CSS).toMatch(/\.verification-row \.popt-input \{[^}]*font-size: clamp\(/s);
  });

  test("read-only and editable values divide the value track by the same per-character model", () => {
    // Two stylesheets carry the same clamp - drawers.css for `.ck-v`, fields.css for
    // the editable input - and a hash overflows its row the moment they disagree.
    for (const css of [DRAWERS_CSS, FIELDS_CSS]) {
      const clamps = [...css.matchAll(/font-size: clamp\(\.46rem,.*/g)].map(([line]) => line);
      expect(clamps.length).toBe(1);
      expect(clamps[0]).toContain("/ var(--ck-v-divisor");
    }
  });
});
