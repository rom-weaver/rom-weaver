import { describe, expect, it } from "vitest";
import { matchPagesHeaders, parsePagesHeaders } from "../../scripts/pages-headers.mjs";

// The shape writeCloudflareHeadersAsset emits.
const headersFile = `/*
  Cross-Origin-Embedder-Policy: require-corp
  Content-Signal: ai-train=no, search=yes, ai-input=yes
  ! Link

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/*.html.br
  Content-Encoding: br

/cache-service-worker.js
  Cache-Control: no-cache
`;

const rules = parsePagesHeaders(headersFile);

describe("pages _headers matching", () => {
  it("applies the /* block to a document", () => {
    expect(matchPagesHeaders(rules, "/")).toEqual({
      "Content-Signal": "ai-train=no, search=yes, ai-input=yes",
      "Cross-Origin-Embedder-Policy": "require-corp",
    });
  });

  it.each(["/apply", "/docs/getting-started/", "/404.html"])("disables Link hints for %s", (pathname) => {
    expect(matchPagesHeaders(rules, pathname).Link).toBeUndefined();
  });

  it("layers a narrower rule over the broad one", () => {
    const matched = matchPagesHeaders(rules, "/assets/index-abc.css");
    expect(matched["Cache-Control"]).toBe("public, max-age=31536000, immutable");
    expect(matched["Cross-Origin-Embedder-Policy"]).toBe("require-corp");
  });

  it("marks HTML sidecars as already Brotli encoded", () => {
    const matched = matchPagesHeaders(rules, "/apply/index.html.br");
    expect(matched["Content-Encoding"]).toBe("br");
  });

  it("lets a later exact rule win over an earlier wildcard", () => {
    expect(matchPagesHeaders(rules, "/cache-service-worker.js")["Cache-Control"]).toBe("no-cache");
  });

  it("keeps a splat from leaking across a path it does not cover", () => {
    expect(matchPagesHeaders(rules, "/index.html")["Cache-Control"]).toBeUndefined();
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
