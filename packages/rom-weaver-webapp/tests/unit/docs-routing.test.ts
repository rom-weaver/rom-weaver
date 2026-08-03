import { describe, expect, it } from "vitest";
import {
  createDocsSeoMetadata,
  DOC_SOURCES,
  docGroupTitle,
  groupDocRoutes,
  isLegalDocRoute,
  readDocsSlugFromPathname,
  SITE_ORIGIN,
} from "../../src/webapp/docs-routing.mjs";

describe("readDocsSlugFromPathname", () => {
  it("resolves a known slug", () => {
    expect(readDocsSlugFromPathname("/docs/faq")).toBe("docs/faq");
  });

  it("resolves the docs root itself", () => {
    expect(readDocsSlugFromPathname("/docs")).toBe("docs");
  });

  it("is case-insensitive", () => {
    expect(readDocsSlugFromPathname("/DOCS/FAQ")).toBe("docs/faq");
  });

  it("falls back to docs root for an unknown slug", () => {
    expect(readDocsSlugFromPathname("/docs/not-a-real-page")).toBe("docs");
  });

  it("falls back to docs root when there is no docs segment", () => {
    expect(readDocsSlugFromPathname("/apply")).toBe("docs");
  });

  it("falls back to docs root for an empty pathname", () => {
    expect(readDocsSlugFromPathname("")).toBe("docs");
    expect(readDocsSlugFromPathname(undefined)).toBe("docs");
  });

  it("strips a trailing index.html", () => {
    expect(readDocsSlugFromPathname("/docs/faq/index.html")).toBe("docs/faq");
  });

  it("strips a trailing .html extension", () => {
    expect(readDocsSlugFromPathname("/docs/faq.html")).toBe("docs/faq");
  });

  it("ignores a trailing slash", () => {
    expect(readDocsSlugFromPathname("/docs/faq/")).toBe("docs/faq");
  });

  it("uses the last docs segment when docs appears more than once", () => {
    expect(readDocsSlugFromPathname("/docs/docs/faq")).toBe("docs/faq");
  });
});

describe("groupDocRoutes", () => {
  it("buckets routes by group, in first-seen order", () => {
    const routes = [
      { group: "How-to guides", slug: "docs/a" },
      { group: "Start here", slug: "docs/b" },
      { group: "How-to guides", slug: "docs/c" },
    ];
    const shelves = groupDocRoutes(routes);
    expect(shelves.map((shelf) => shelf.title)).toEqual(["How-to guides", "Start here"]);
    expect(shelves[0]?.routes.map((route) => route.slug)).toEqual(["docs/a", "docs/c"]);
    expect(shelves[1]?.routes.map((route) => route.slug)).toEqual(["docs/b"]);
  });

  it("returns an empty list for no routes", () => {
    expect(groupDocRoutes([])).toEqual([]);
  });

  it("puts every route in exactly one shelf", () => {
    const shelves = groupDocRoutes(DOC_SOURCES.map((source) => ({ ...source, group: docGroupTitle(source.file) })));
    const total = shelves.reduce((sum, shelf) => sum + shelf.routes.length, 0);
    expect(total).toBe(DOC_SOURCES.length);
  });
});

describe("createDocsSeoMetadata", () => {
  const route = { description: "A description.", slug: "docs/faq", title: "FAQ" };

  it("builds a canonical url and page title", () => {
    const meta = createDocsSeoMetadata(route);
    expect(meta.canonicalUrl).toBe(`${SITE_ORIGIN}/docs/faq`);
    expect(meta.title).toBe("FAQ | rom-weaver");
  });

  it("appends a channel label to the site name when given", () => {
    const meta = createDocsSeoMetadata(route, "Beta");
    expect(meta.title).toBe("FAQ | rom-weaver Beta");
  });

  it("includes description and og/twitter metadata tags", () => {
    const meta = createDocsSeoMetadata(route);
    expect(meta.metadata).toContainEqual(["name", "description", route.description]);
    expect(meta.metadata).toContainEqual(["property", "og:url", meta.canonicalUrl]);
    expect(meta.metadata).toContainEqual(["property", "og:title", meta.title]);
    expect(meta.metadata).toContainEqual(["name", "twitter:title", meta.title]);
  });
});

describe("isLegalDocRoute", () => {
  it("flags the known legal routes", () => {
    expect(isLegalDocRoute("docs/about")).toBe(true);
    expect(isLegalDocRoute("docs/notices")).toBe(true);
    expect(isLegalDocRoute("docs/privacy")).toBe(true);
  });

  it("does not flag other routes", () => {
    expect(isLegalDocRoute("docs/faq")).toBe(false);
    expect(isLegalDocRoute("docs")).toBe(false);
    expect(isLegalDocRoute("")).toBe(false);
  });
});

describe("docGroupTitle", () => {
  it("maps the root folder to 'Start here'", () => {
    expect(docGroupTitle("README.md")).toBe("Start here");
  });

  it("maps how-to to 'How-to guides'", () => {
    expect(docGroupTitle("how-to/apply-rom-patches.md")).toBe("How-to guides");
  });

  it("capitalizes an unmapped folder name", () => {
    expect(docGroupTitle("tutorials/first-patch.md")).toBe("Tutorials");
    expect(docGroupTitle("explanation/local-first.md")).toBe("Explanation");
  });

  it("capitalizes only the first character of a longer folder name", () => {
    expect(docGroupTitle("hosting/self-hosting.md")).toBe("Hosting");
  });
});
