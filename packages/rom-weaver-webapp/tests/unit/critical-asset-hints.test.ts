import { describe, expect, it } from "vitest";
import { criticalAssetLinkHeaders } from "../../scripts/critical-asset-hints.mjs";

const stylesheetTag = '<link rel="stylesheet" crossorigin href="./assets/index-UWYfzcLg.css" />';
const entryModuleTag = '<script type="module" crossorigin src="./assets/index-lgao6CRe.js"></script>';
// Vite rewrites the source preload tag with its own attribute order (as/crossorigin
// before href/rel), so the fixture mirrors the built output rather than the source.
const fontTag =
  '<link as="font" crossorigin="" href="./assets/archivo-var-latin-DXrUVZxZ.woff2" rel="preload" type="font/woff2">';
const indexHtml = `<!doctype html><html><head>
  ${fontTag}
  ${stylesheetTag}
  ${entryModuleTag}
</head><body></body></html>`;

describe("critical asset link headers", () => {
  it("names the hashed URLs the document requests, rooted at the origin", () => {
    expect(criticalAssetLinkHeaders(indexHtml)).toEqual([
      "Link: </assets/index-UWYfzcLg.css>; rel=preload; as=style; crossorigin",
      "Link: </assets/index-lgao6CRe.js>; rel=preload; as=script; crossorigin",
      "Link: </assets/archivo-var-latin-DXrUVZxZ.woff2>; rel=preload; as=font; crossorigin",
    ]);
  });

  // Cloudflare replays only `preload` and `preconnect` in the 103, so a `modulepreload`
  // entry hint would be dropped from the Early Hints and lose the point of the header.
  it("hints the entry module with rel=preload rather than modulepreload", () => {
    expect(criticalAssetLinkHeaders(indexHtml)[1]).not.toContain("modulepreload");
  });

  it.each([
    ["stylesheet", indexHtml.replace(stylesheetTag, "")],
    ["entry module", indexHtml.replace(entryModuleTag, "")],
    ["webfont preload", indexHtml.replace(fontTag, "")],
  ])("throws when index.html has no %s", (label, html) => {
    expect(() => criticalAssetLinkHeaders(html)).toThrow(`index.html is missing its ${label}`);
  });
});
