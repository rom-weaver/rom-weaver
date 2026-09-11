import { describe, expect, it } from "vitest";
import { assetCacheControl, isMutableAsset } from "../../functions/assets/content-types.js";
import { matchPagesHeaders, parsePagesHeaders } from "../../scripts/pages-headers.mjs";

// The shape writeCloudflareHeadersAsset emits.
const headersFile = `/*
  Cross-Origin-Embedder-Policy: require-corp
  Cache-Control: no-cache
  Content-Signal: ai-train=no, search=yes, ai-input=yes
  ! Link

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/assets/identify-index.json
  Cache-Control: no-cache
`;

const rules = parsePagesHeaders(headersFile);

describe("pages _headers matching", () => {
  it("applies the /* block to a document", () => {
    expect(matchPagesHeaders(rules, "/")).toEqual({
      "Cache-Control": "no-cache",
      "Content-Signal": "ai-train=no, search=yes, ai-input=yes",
      "Cross-Origin-Embedder-Policy": "require-corp",
    });
  });

  it.each(["/apply-patch", "/docs/getting-started/", "/404.html"])("disables Link hints for %s", (pathname) => {
    expect(matchPagesHeaders(rules, pathname).Link).toBeUndefined();
  });

  it("layers a narrower rule over the broad one", () => {
    const matched = matchPagesHeaders(rules, "/assets/index-abc.css");
    expect(matched["Cache-Control"]).toBe("public, max-age=31536000, immutable");
    expect(matched["Cross-Origin-Embedder-Policy"]).toBe("require-corp");
  });

  // The script has no rule of its own: a rule that unsets Cache-Control to restate
  // the same value is what dropped the header in production, so /* now owns it.
  it("revalidates the service worker script through the broad rule", () => {
    expect(matchPagesHeaders(rules, "/rom-weaver-service-worker.js")["Cache-Control"]).toBe("no-cache");
  });

  it("revalidates the identify index and keeps content-addressed packs immutable", () => {
    expect(matchPagesHeaders(rules, "/assets/identify-index.json")["Cache-Control"]).toBe("no-cache");
    expect(matchPagesHeaders(rules, "/assets/identify-sega-32x.pack.br")["Cache-Control"]).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  // /index.html keeps the broad rule's no-cache: the immutable splat covers only /assets/.
  it("keeps a splat from leaking across a path it does not cover", () => {
    expect(matchPagesHeaders(rules, "/index.html")["Cache-Control"]).toBe("no-cache");
  });

  it("keeps the identify manifests revalidated and everything else immutable", () => {
    expect(assetCacheControl("/assets/identify-index.json")).toBe("no-cache");
    expect(assetCacheControl("/assets/identify-catalog.json")).toBe("no-cache");
    expect(isMutableAsset("/assets/identify-catalog.json")).toBe(true);
    for (const pathname of ["/assets/identify-sega-32x.pack", "/assets/index-abc.js"]) {
      expect(isMutableAsset(pathname)).toBe(false);
      expect(assetCacheControl(pathname)).toBe("public, max-age=31536000, immutable");
    }
  });

  it("ignores comments, blank lines, and indented lines with no pattern", () => {
    expect(parsePagesHeaders("  Orphan: 1\n\n# comment\n/*\n  X: 2\n")).toEqual([
      { headers: [["X", "2"]], match: expect.any(RegExp) },
    ]);
  });

  it("treats regex metacharacters in a pattern literally", () => {
    const dotted = parsePagesHeaders("/a.b\n  X: 1\n");
    expect(matchPagesHeaders(dotted, "/a.b").X).toBe("1");
    expect(matchPagesHeaders(dotted, "/axb").X).toBeUndefined();
  });
});
