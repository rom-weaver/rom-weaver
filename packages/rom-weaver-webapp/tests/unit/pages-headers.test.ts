import { describe, expect, it } from "vitest";
import { matchPagesHeaders, parsePagesHeaders } from "../../scripts/pages-headers.mjs";

// The shape writeCloudflareHeadersAsset emits.
const headersFile = `/*
  Cross-Origin-Embedder-Policy: require-corp
  Content-Signal: ai-train=no, search=yes, ai-input=yes
  Link: </assets/index-abc.css>; rel=preload; as=style; crossorigin
  Link: </assets/index-def.js>; rel=preload; as=script; crossorigin

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/cache-service-worker.js
  Cache-Control: no-cache
`;

const rules = parsePagesHeaders(headersFile);

describe("pages _headers matching", () => {
  it("applies the /* block to a document", () => {
    expect(matchPagesHeaders(rules, "/")).toEqual({
      "Content-Signal": "ai-train=no, search=yes, ai-input=yes",
      "Cross-Origin-Embedder-Policy": "require-corp",
      Link: [
        "</assets/index-abc.css>; rel=preload; as=style; crossorigin",
        "</assets/index-def.js>; rel=preload; as=script; crossorigin",
      ],
    });
  });

  // A prerendered route is a different path but loads the same two assets, so it has to
  // pick up the same hints - that is why they ride in `/*` rather than a route list.
  it.each(["/apply", "/docs/getting-started/", "/404.html"])("applies the /* block to %s", (pathname) => {
    expect(matchPagesHeaders(rules, pathname).Link).toHaveLength(2);
  });

  it("layers a narrower rule over the broad one", () => {
    const matched = matchPagesHeaders(rules, "/assets/index-abc.css");
    expect(matched["Cache-Control"]).toBe("public, max-age=31536000, immutable");
    expect(matched["Cross-Origin-Embedder-Policy"]).toBe("require-corp");
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

  it("keeps a value containing a colon intact", () => {
    expect(matchPagesHeaders(parsePagesHeaders("/*\n  Link: <https://x/y>; rel=preconnect\n"), "/").Link).toEqual([
      "<https://x/y>; rel=preconnect",
    ]);
  });

  it("treats regex metacharacters in a pattern literally", () => {
    const dotted = parsePagesHeaders("/a.b\n  X: 1\n");
    expect(matchPagesHeaders(dotted, "/a.b").X).toBe("1");
    expect(matchPagesHeaders(dotted, "/axb").X).toBeUndefined();
  });
});
