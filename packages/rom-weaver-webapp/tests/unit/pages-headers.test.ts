import { describe, expect, it } from "vitest";
import { matchPagesHeaders, parsePagesHeaders } from "../../scripts/pages-headers.mjs";

// The shape writeCloudflareHeadersAsset emits.
const headersFile = `/*
  Cross-Origin-Embedder-Policy: require-corp
  Content-Signal: ai-train=yes, search=yes, ai-input=yes
  ! Link

/assets/*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable

/assets/identify-index.json
  ! Cache-Control
  Cache-Control: no-cache

/rom-weaver-service-worker.js
  Cache-Control: no-cache
`;

const rules = parsePagesHeaders(headersFile);

describe("pages _headers matching", () => {
  it("applies the /* block to a document", () => {
    expect(matchPagesHeaders(rules, "/")).toEqual({
      "Content-Signal": "ai-train=yes, search=yes, ai-input=yes",
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

  it("lets a later exact rule win over an earlier wildcard", () => {
    expect(matchPagesHeaders(rules, "/rom-weaver-service-worker.js")["Cache-Control"]).toBe("no-cache");
  });

  it("revalidates the identify index and keeps content-addressed packs immutable", () => {
    expect(matchPagesHeaders(rules, "/assets/identify-index.json")["Cache-Control"]).toBe("no-cache");
    expect(matchPagesHeaders(rules, "/assets/identify-sega-32x.pack.br")["Cache-Control"]).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  it("keeps a splat from leaking across a path it does not cover", () => {
    expect(matchPagesHeaders(rules, "/index.html")["Cache-Control"]).toBeUndefined();
  });

  it("ignores comments, blank lines, and indented lines with no pattern", () => {
    expect(parsePagesHeaders("  Orphan: 1\n\n# comment\n/*\n  X: 2\n")).toEqual([
      { headers: [["X", "2"]], match: expect.any(RegExp) },
    ]);
  });

  it("appends a header that a later rule sets again without unsetting it", () => {
    const layered = parsePagesHeaders("/*\n  X: 1\n\n/a\n  X: 2\n\n/b\n  ! X\n  X: 3\n");
    expect(matchPagesHeaders(layered, "/a").X).toBe("1, 2");
    expect(matchPagesHeaders(layered, "/b").X).toBe("3");
  });

  it("matches placeholders inside a segment and substitutes them into values", () => {
    const markdown = parsePagesHeaders(
      '/docs/:page.md\n  Link: <https://rom-weaver.com/docs/:page>; rel="canonical"\n\n/files/*\n  X-Path: :splat\n',
    );
    expect(matchPagesHeaders(markdown, "/docs/use-cheats.md").Link).toEqual([
      '<https://rom-weaver.com/docs/use-cheats>; rel="canonical"',
    ]);
    expect(matchPagesHeaders(markdown, "/docs/a/b.md").Link).toBeUndefined();
    expect(matchPagesHeaders(markdown, "/docs/.md").Link).toBeUndefined();
    expect(matchPagesHeaders(markdown, "/files/a/b.txt")["X-Path"]).toBe("a/b.txt");
  });

  it("replaces a placeholder Link through an exception that unsets it", () => {
    const markdown = parsePagesHeaders(
      '/:page.md\n  Link: <https://rom-weaver.com/:page>; rel="canonical"\n\n/index.md\n  ! Link\n  Link: <https://rom-weaver.com/>; rel="canonical"\n\n/auth.md\n  ! Link\n',
    );
    expect(matchPagesHeaders(markdown, "/index.md").Link).toEqual(['<https://rom-weaver.com/>; rel="canonical"']);
    expect(matchPagesHeaders(markdown, "/auth.md").Link).toBeUndefined();
    expect(matchPagesHeaders(markdown, "/checksum.md").Link).toEqual([
      '<https://rom-weaver.com/checksum>; rel="canonical"',
    ]);
  });

  it("treats regex metacharacters in a pattern literally", () => {
    const dotted = parsePagesHeaders("/a.b\n  X: 1\n");
    expect(matchPagesHeaders(dotted, "/a.b").X).toBe("1");
    expect(matchPagesHeaders(dotted, "/axb").X).toBeUndefined();
  });
});
