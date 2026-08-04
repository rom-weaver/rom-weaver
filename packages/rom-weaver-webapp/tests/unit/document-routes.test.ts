import { describe, expect, it } from "vitest";
import {
  DOCUMENT_ROUTE_EXCLUDES,
  DOCUMENT_ROUTE_INCLUDES,
  documentSidecarPath,
  documentSidecarPaths,
} from "../../functions/document-routes.js";

describe("Cloudflare document sidecar routes", () => {
  it("covers the clean document routes without routing screenshots", () => {
    expect(DOCUMENT_ROUTE_INCLUDES).toContain("/");
    expect(DOCUMENT_ROUTE_INCLUDES).toContain("/docs/*");
    expect(DOCUMENT_ROUTE_EXCLUDES).toEqual(["/docs/screenshots/*"]);
  });

  it.each([
    ["/", "/index.html.br"],
    ["/apply", "/apply/index.html.br"],
    ["/create/", "/create/index.html.br"],
    ["/docs/faq", "/docs/faq/index.html.br"],
    ["/docs/faq/index.html", "/docs/faq/index.html.br"],
  ])("maps %s to %s", (pathname, sidecarPath) => {
    expect(documentSidecarPath(pathname)).toBe(sidecarPath);
  });

  it("declines paths that already name a sidecar", () => {
    expect(documentSidecarPath("/assets/app.js.br")).toBeNull();
    expect(documentSidecarPaths("/assets/app.js")).toEqual([]);
  });

  it("keeps the generated index document as the first clean-route candidate", () => {
    expect(documentSidecarPaths("/trim")).toEqual(["/trim/index.html.br", "/trim.html.br"]);
  });
});
