import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * Keep editable checksum inputs at the font-size floor while exempting compact select controls.
 * This source check covers the WebKit feature-gated rule even when the test browser does not apply it.
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

/**
 * Selectors in the floor block that set `font-size` on the bare `<input>` / `<select>`
 * element - the broad ones that sweep up every control. Class selectors like
 * `.rw-app .select` are deliberately excluded: no dropdown in these families carries a
 * `select` class (they carry `meta-target-select`), so those rules cannot reach them.
 */
const floorSelectorsFor = (element: "input" | "select"): string[] =>
  [...iosFloorBlock().matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, , declarations]) => declarations.includes("font-size"))
    .flatMap(([, selectorList]) => selectorList.split(","))
    .map((selector) => selector.replaceAll(/\/\*[^*]*\*+([^/*][^*]*\*+)*\//g, "").trim())
    .filter((selector) => new RegExp(String.raw`(^|\s)${element}(:|$)`).test(selector))
    // The reassert block deliberately re-floors named fields outside the drawer.
    .filter((selector) => !/\.(ofld|fname)\s/.test(selector));

describe("iOS check font floor", () => {
  test("the floor skips every self-sizing dropdown family", () => {
    // Keyed off the classes that define the family, not per call site, so a new header /
    // target / basis picker is unified with the rest the moment it is added.
    const selectors = floorSelectorsFor("select");
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      expect(selector, selector).toContain(":not(.meta-target-select)");
      expect(selector, selector).toContain(":not(.ck-add-select)");
    }
  });

  test("no dropdown call site opts out by hand", () => {
    // Every one of these carries .meta-target-select, which is what the floor skips.
    expect([...PATCH_LIST_STEP.matchAll(/className="meta-target-select[^"]*"/g)].length).toBeGreaterThan(0);
    expect(PATCH_LIST_STEP).not.toContain("ck-tight");
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
    for (const selector of selectors) expect(selector, selector).not.toContain("popt-input");
  });

  test("resting text and the field divide the value track by the same per-character model", () => {
    // Two stylesheets carry the same clamp - drawers.css for the read-only rows,
    // fields.css for both states of an editable one - and a hash overflows its row the
    // moment they disagree.
    for (const css of [DRAWERS_CSS, FIELDS_CSS]) {
      // Matched across newlines and re-spaced: the clamp is wider than the CSS
      // formatter's line budget, so it is wrapped over several lines.
      const clamps = [...css.matchAll(/font-size:\s*clamp\(\s*0?\.46rem,[\s\S]*?\);/g)].map(([line]) =>
        line.replace(/\s+/g, " "),
      );
      expect(clamps.length).toBe(1);
      expect(clamps[0]).toContain("/ var(--ck-v-divisor");
    }
  });
});
