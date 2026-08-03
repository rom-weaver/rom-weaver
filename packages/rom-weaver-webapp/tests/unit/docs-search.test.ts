// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { DOC_PAGE_LOADERS, DOC_ROUTES } from "virtual:rom-weaver-docs";
import { createDocRoute } from "../../src/webapp/docs-content.mjs";
import { createDocsSearchIndex, findSearchToken, searchDocs, searchTokens } from "../../src/webapp/docs-search.mjs";

const route = createDocRoute(
  { file: "how-to/fixture.md", label: "Checksum guide", slug: "docs/fixture" },
  `# Checksum guide

Find the right checksum workflow here.

## Repair checksum errors

Use the checksum tool when a file does not match.

## Browser storage

The browser keeps large files in OPFS storage.
`,
);
const [indexedRoute] = createDocsSearchIndex([route]);

describe("docs search", () => {
  it("normalizes punctuation and diacritics into searchable tokens", () => {
    expect(searchTokens("Éxtract, checksum-errors!")).toEqual(["extract", "checksum", "errors"]);
  });

  it("finds a typo in a section body and preserves its anchor", () => {
    const [result] = searchDocs([indexedRoute], "checksumm tool");

    expect(result?.entry.id).toBe("repair-checksum-errors");
    expect(result?.route.slug).toBe("docs/fixture");
    expect(result?.snippet).toContain("checksum tool");
  });

  it("returns the closest source word to highlight after a fuzzy match", () => {
    expect(findSearchToken("Use the checksum tool here.", "checksumm")?.text).toBe("checksum");
  });

  it("searches body text and returns a page-relative result when needed", () => {
    const [result] = searchDocs([indexedRoute], "OPFS");

    expect(result?.entry.id).toBe("browser-storage");
    expect(result?.entry.label).toBe("Browser storage");
  });

  it("requires every query token and limits results", () => {
    expect(searchDocs([indexedRoute], "checksum missing-token")).toEqual([]);
    expect(
      searchDocs(
        Array.from({ length: 12 }, () => indexedRoute),
        "checksum",
        8,
      ),
    ).toHaveLength(8);
    expect(searchDocs([indexedRoute], "   ")).toEqual([]);
  });

  it("keeps generated search entries aligned with published section anchors", async () => {
    // Guide HTML ships as one lazy chunk per page; join it back onto the
    // metadata routes to index the published guides the way the build does.
    const publishedRoutes = await Promise.all(
      DOC_ROUTES.map(async (docRoute) => ({ ...docRoute, html: (await DOC_PAGE_LOADERS[docRoute.slug]()).html })),
    );
    for (const publishedRoute of createDocsSearchIndex(publishedRoutes)) {
      expect(publishedRoute.searchEntries.map((entry) => entry.id)).toEqual([
        null,
        ...publishedRoute.sections.map((section) => section.id),
      ]);
      expect(publishedRoute.searchEntries.every((entry) => entry.text.length > 0)).toBe(true);
    }
  });
});
