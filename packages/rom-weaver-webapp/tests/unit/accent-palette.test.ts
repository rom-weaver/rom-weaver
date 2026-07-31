import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ACCENTS } from "../../src/webapp/accent.ts";

/**
 * accent.ts is the source of truth for the dye lots, but the values also live
 * as literals in three other places that can't import it: the CSS custom
 * properties, and the rasterized channel icons. Nothing at runtime would notice
 * them drifting apart - the picker would just show a swatch that doesn't match
 * the UI it selects - so assert the copies here.
 */

const read = (relativePath: string) => readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

const TOKENS_CSS = read("../../src/webapp/design-system/tokens.css");
const ACCENTS_CSS = read("../../src/webapp/design-system/accents.css");

/** Pull a custom property out of a `:root[data-accent="<name>"]` block. */
const readAccentToken = (accent: string, property: string): string | undefined => {
  const block = new RegExp(`:root\\[data-accent="${accent}"\\]\\s*\\{([^}]*)\\}`).exec(ACCENTS_CSS);
  if (!block) return undefined;
  return new RegExp(`${property}:\\s*(#[0-9a-f]{6})`).exec(block[1])?.[1];
};

const readRootToken = (property: string): string | undefined =>
  new RegExp(`${property}:\\s*(#[0-9a-f]{6})`).exec(TOKENS_CSS)?.[1];

describe("accent palette", () => {
  test("madder is the tokens.css baseline and has no accent block", () => {
    expect(readRootToken("--thread")).toBe("#d9690f");
    expect(readRootToken("--thread-hi")).toBe("#fccb90");
    expect(ACCENTS_CSS).not.toContain('data-accent="madder"');
  });

  test("madder in accent.ts matches the baseline tokens", () => {
    const madder = ACCENTS.find((accent) => accent.value === "madder");
    expect(madder?.swatch).toBe(readRootToken("--thread"));
    expect(madder?.highlight).toBe(readRootToken("--thread-hi"));
  });

  for (const accent of ACCENTS.filter((entry) => entry.value !== "madder")) {
    test(`${accent.value} swatch and highlight match its CSS block`, () => {
      expect(readAccentToken(accent.value, "--thread")).toBe(accent.swatch);
      expect(readAccentToken(accent.value, "--thread-hi")).toBe(accent.highlight);
    });
  }

  test("every accent has a distinct swatch", () => {
    const swatches = ACCENTS.map((accent) => accent.swatch);
    expect(new Set(swatches).size).toBe(swatches.length);
  });
});

/**
 * index.html resolves data-accent before first paint, from a literal list it
 * cannot import. An accent missing from that list is not rejected - it falls
 * through to the channel default, paints wrong, then snaps when accent.ts boots.
 */
describe("parser-time accent resolver", () => {
  test("index.html lists exactly the accents accent.ts defines", () => {
    const html = read("../../index.html");
    const listed = /const accents = \[([^\]]*)\]/.exec(html)?.[1];
    expect(listed).toBeDefined();
    const values = (listed as string).split(",").map((entry) => entry.trim().replace(/^"|"$/g, ""));
    expect(values.sort()).toEqual(ACCENTS.map((accent) => accent.value).sort());
  });
});
