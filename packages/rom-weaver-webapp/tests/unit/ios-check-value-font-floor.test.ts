import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * The iOS focus-zoom floor in webapp-modals.css raises every field to 16px, and its
 * layer sits after the ones sizing the checks drawer's own controls - so without the
 * `.ck-tight` opt-out all three render at 16px on iOS: the md5/sha-1 values, which no
 * phone is wide enough to fit at that size, and the two dropdowns, which overflow the
 * group head and stretch the gap between the Input and Output sections.
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

/** Every `font-size` selector in the floor block that an `<input>`/`<select>` could match. */
const selectorsAControlCanMatch = (block: string): string[] =>
  [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, , declarations]) => declarations.includes("font-size"))
    .flatMap(([, selectorList]) => selectorList.split(","))
    .map((selector) => selector.replaceAll(/\/\*[^*]*\*+([^/*][^*]*\*+)*\//g, "").trim())
    .filter((selector) => /(^|\s)\.?(input|select)(:|$)/.test(selector));

describe("iOS check-value font floor", () => {
  test("the floor exempts .ck-tight from every selector a check control matches", () => {
    const selectors = selectorsAControlCanMatch(iosFloorBlock());
    expect(selectors.length).toBeGreaterThan(0);
    // The reassert block deliberately re-applies the floor to named fields outside the
    // drawer; only the broad selectors that would sweep up a .ck-tight control matter.
    for (const selector of selectors.filter((s) => !/\.(ofld|fname)\s/.test(s))) {
      expect(selector, selector).toContain(":not(.ck-tight)");
    }
  });

  test("every checks-drawer control carries .ck-tight", () => {
    for (const marker of ["input mono popt-input ck-tight", "ck-basis-select ck-tight", "ck-add-select ck-tight"]) {
      expect(PATCH_LIST_STEP, marker).toContain(marker);
    }
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
