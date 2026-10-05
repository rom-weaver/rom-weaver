import { describe, expect, it } from "vitest";
import { docsVirtualModule } from "../../scripts/docs-virtual-module.mjs";
import { createDocsSearchIndex, searchDocs } from "../../src/webapp/docs-search.mjs";
import { DOC_SOURCES } from "../../src/webapp/docs-routing.mjs";

const METADATA_ID = "\0virtual:rom-weaver-docs";
const PAGE_ID_PREFIX = "\0virtual:rom-weaver-docs-page/";

/** Render the metadata module the plugin generates for the given routes. */
const generateMetadataSource = (routes: { html: string; slug: string; title: string }[]) =>
  // The plugin is a Vite hook object, so the handler runs with no plugin context.
  docsVirtualModule(routes).load.handler.call(null, METADATA_ID) as string;

const route = (slug: string) => ({ html: "<p>body</p>", slug, title: "Title" });

describe("docs virtual module slugs", () => {
  it("emits one lazy page loader per route", () => {
    const source = generateMetadataSource([route("docs"), route("docs/faq")]);
    expect(source).toContain('"docs": () => import("virtual:rom-weaver-docs-page/docs")');
    expect(source).toContain('"docs/faq": () => import("virtual:rom-weaver-docs-page/docs/faq")');
  });

  it("accepts every published slug", () => {
    expect(() => generateMetadataSource(DOC_SOURCES.map((source) => route(source.slug)))).not.toThrow();
  });

  it.each([
    ["a quote", 'docs/"a'],
    ["a backslash", "docs/a\\b"],
    ["a template placeholder", "docs/${a}"],
    ["a closing script tag", "docs/a</script>"],
    ["a parent traversal", "docs/../a"],
    ["a line separator", "docs/a\u2028b"],
    ["an empty slug", ""],
  ])("refuses a slug with %s", (_label, slug) => {
    expect(() => generateMetadataSource([route(slug)])).toThrow(/not a safe route slug/);
  });
});

describe("docs virtual module escaping", () => {
  const generatePageSource = (html: string) => {
    const routes = [{ ...route("docs"), html }];
    return docsVirtualModule(routes).load.handler.call(null, `${PAGE_ID_PREFIX}docs`) as string;
  };

  it("escapes characters that could break out of the generated string literal", () => {
    const source = generatePageSource("<p>a</p><script>b</script>\u2028\u2029");
    expect(source).not.toContain("<");
    expect(source).not.toContain(">");
    expect(source).toContain("\\u003C");
    expect(source).toContain("\\u2028");
    expect(source).toContain("\\u2029");
  });

  it("still round-trips the guide's HTML unchanged", async () => {
    const html = "<p>a</p><script>b</script>\u2028\u2029";
    const source = generatePageSource(html);
    const loaded = await import(`data:text/javascript,${encodeURIComponent(source)}`);
    expect(loaded.html).toBe(html);
  });
});

describe("docs virtual search module", () => {
  const sampleRoute = {
    description: "Patch a ROM safely",
    html: '<h1>Guide</h1><p>Start here.</p><h2 id="checks">Safety checks</h2><p>Verify CRC32 &amp; SHA-256 before applying.</p>',
    label: "Guide",
    sections: [{ id: "checks", label: "Checks" }],
    slug: "docs/guide",
    title: "Patch guide",
  };
  const routes = [sampleRoute];

  const sourceFor = (input = routes) =>
    docsVirtualModule(input).load.handler.call(null, "\0virtual:rom-weaver-docs-search") as string;

  it("reduces the generated search payload by at least ten percent", () => {
    const manyRoutes = Array.from({ length: 100 }, (_, index) => ({ ...sampleRoute, slug: `docs/guide-${index}` }));
    const plain = JSON.stringify(
      Object.fromEntries(createDocsSearchIndex(manyRoutes).map((r) => [r.slug, r.searchEntries])),
    );
    expect(Buffer.byteLength(sourceFor(manyRoutes))).toBeLessThan(Buffer.byteLength(plain) * 0.9);
  });

  it("stores a repeated entry label only once", () => {
    expect(sourceFor().split(sampleRoute.title)).toHaveLength(2);
  });

  it("preserves all entries and search results after loading", async () => {
    const loaded = await import(`data:text/javascript,${encodeURIComponent(sourceFor())}`);
    const index = createDocsSearchIndex(routes);
    expect(loaded.SEARCH_ENTRIES).toEqual(Object.fromEntries(index.map((r) => [r.slug, r.searchEntries])));
    const restored = index.map((r) => ({ ...r, searchEntries: loaded.SEARCH_ENTRIES[r.slug] }));
    expect(searchDocs(restored, "CRC32")).toEqual(searchDocs(index, "CRC32"));
  });

  it("preserves empty routes and escaped Unicode text", async () => {
    const special = [{ ...sampleRoute, title: 'Quotes " <script> \u2028 \u2029 日本語' }];
    for (const input of [[], special]) {
      const source = sourceFor(input);
      expect(source).not.toContain("<script>");
      const loaded = await import(`data:text/javascript,${encodeURIComponent(source)}`);
      const index = createDocsSearchIndex(input);
      expect(loaded.SEARCH_ENTRIES).toEqual(Object.fromEntries(index.map((r) => [r.slug, r.searchEntries])));
    }
  });

  it("preserves text when the section label differs from its heading", async () => {
    const input = [{ ...sampleRoute, sections: [{ id: "checks", label: "Verification" }] }];
    const loaded = await import(`data:text/javascript,${encodeURIComponent(sourceFor(input))}`);
    const index = createDocsSearchIndex(input);
    expect(loaded.SEARCH_ENTRIES).toEqual(Object.fromEntries(index.map((r) => [r.slug, r.searchEntries])));
  });
});
