import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * iOS Safari zooms the page in when a text field under 16px takes focus, so
 * webapp-modals.css floors every field at 16px from a later cascade layer. The checks
 * drawer cannot live with that floor - a 40-character SHA-1 needs ~415px at 16px and no
 * phone has it - and it escapes in two different ways, both asserted here:
 *
 * - the two dropdowns carry `.ck-tight` and the floor skips them. A <select> opens a
 *   native picker rather than a keyboard, so exempting them costs no zoom.
 * - the check values are not fields at rest. `EditableCheckRow` renders the value as a
 *   button and only mounts the input on tap, already at the floor, before focus lands.
 *   The input must therefore NOT be exempt: 16px while editing is what stops the zoom.
 *
 * Nothing in CI can catch a regression here. The rule is gated on
 * `@supports (-webkit-touch-callout: none)`, which only real Safari matches - the
 * Chromium and desktop-WebKit suites both resolve it to false - so the arrangement is
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

/** Selectors in the floor block that set `font-size` on a bare element or field class. */
const floorSelectorsFor = (element: "input" | "select"): string[] =>
  [...iosFloorBlock().matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, , declarations]) => declarations.includes("font-size"))
    .flatMap(([, selectorList]) => selectorList.split(","))
    .map((selector) => selector.replaceAll(/\/\*[^*]*\*+([^/*][^*]*\*+)*\//g, "").trim())
    .filter((selector) => new RegExp(String.raw`(^|\s)\.?${element}(:|$)`).test(selector))
    // The reassert block deliberately re-floors named fields outside the drawer.
    .filter((selector) => !/\.(ofld|fname)\s/.test(selector));

describe("iOS check font floor", () => {
  test("the floor skips the drawer's dropdowns", () => {
    const selectors = floorSelectorsFor("select");
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) expect(selector, selector).toContain(":not(.ck-tight)");
    for (const marker of ["ck-basis-select ck-tight", "ck-add-select ck-tight"]) {
      expect(PATCH_LIST_STEP, marker).toContain(marker);
    }
  });

  test("the check value is a button at rest, not a field", () => {
    // A field mounted at rest would be focused while small, which is the zoom.
    expect(PATCH_LIST_STEP).toContain('className="ck-open mono"');
    expect(FIELDS_CSS).toContain(".verification-row .ck-open");
  });

  test("the floor still reaches the field that replaces it", () => {
    // Exempting this one would hand the zoom straight back.
    expect(PATCH_LIST_STEP).toContain('className="input mono popt-input"');
    const selectors = floorSelectorsFor("input");
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) expect(selector, selector).not.toContain("ck-tight");
  });

  test("resting text and the field divide the value track by the same per-character model", () => {
    // Two stylesheets carry the same clamp - drawers.css for the read-only rows,
    // fields.css for both states of an editable one - and a hash overflows its row the
    // moment they disagree.
    for (const css of [DRAWERS_CSS, FIELDS_CSS]) {
      const clamps = [...css.matchAll(/font-size: clamp\(\.46rem,.*/g)].map(([line]) => line);
      expect(clamps.length).toBe(1);
      expect(clamps[0]).toContain("/ var(--ck-v-divisor");
    }
  });
});
