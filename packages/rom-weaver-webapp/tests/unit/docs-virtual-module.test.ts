import { describe, expect, it } from "vitest";
import { docsVirtualModule } from "../../scripts/docs-virtual-module.mjs";
import { createDocsSearchIndex, searchDocs } from "../../src/webapp/docs-search.mjs";
import { readDocRoutes } from "../../src/webapp/docs-pages.mjs";
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

describe("docs virtual payload round trips", () => {
  const load = (source: string) => import(`data:text/javascript,${encodeURIComponent(source)}`);

  it("preserves every published route's metadata and search entry", async () => {
    const routes = readDocRoutes();
    const plugin = docsVirtualModule(routes);
    const metadata = await load(plugin.load.handler.call(null, METADATA_ID) as string);
    expect(metadata.DOC_ROUTES).toStrictEqual(routes.map(({ html: _html, ...entry }) => entry));
    const search = await load(plugin.load.handler.call(null, "\0virtual:rom-weaver-docs-search") as string);
    expect(search.SEARCH_ENTRIES).toEqual(
      Object.fromEntries(createDocsSearchIndex(routes).map((entry) => [entry.slug, entry.searchEntries])),
    );
  });

  it("preserves every published page's HTML with the shared icon", async () => {
    const routes = readDocRoutes();
    const plugin = docsVirtualModule(routes);
    const iconSource = plugin.load.handler.call(null, "\0virtual:rom-weaver-docs-html") as string;
    const iconUrl = `data:text/javascript,${encodeURIComponent(iconSource)}`;
    for (const entry of routes) {
      const source = plugin.load.handler.call(null, `${PAGE_ID_PREFIX}${entry.slug}`) as string;
      const loaded = await load(source.replace('"virtual:rom-weaver-docs-html"', JSON.stringify(iconUrl)));
      expect(loaded.html, entry.slug).toBe(entry.html);
    }
  });

  it("preserves custom IDs, duplicate heading IDs, punctuation and Unicode labels", async () => {
    const labels = ["Simple heading", "Simple heading", 'Quotes " & < >', "日本語", "", "  Leading and trailing  "];
    const sections = labels.map((label, index) => ({
      id: ["simple-heading", "simple-heading-1", "custom", "unicode", "empty", "leading-and-trailing"][index],
      label,
    }));
    const entry = {
      ...route("docs/adversarial"),
      description: "Description",
      label: "Guide",
      sections,
      html: sections.map(({ id, label }) => `<h2 id="${id}">${label}</h2><p>$& $' \\ \u2028 \u2029</p>`).join(""),
    };
    const plugin = docsVirtualModule([entry]);
    const metadata = await load(plugin.load.handler.call(null, METADATA_ID) as string);
    expect(metadata.DOC_ROUTES[0].sections).toEqual(sections);
    const search = await load(plugin.load.handler.call(null, "\0virtual:rom-weaver-docs-search") as string);
    expect(search.SEARCH_ENTRIES[entry.slug]).toEqual(createDocsSearchIndex([entry])[0].searchEntries);
  });

  it("splits exact icon occurrences without interpreting surrounding literals", async () => {
    const icon = '<svg class="docs-section-link-icon"><path d="test"/></svg>';
    const html = `${icon}$& $' \\ \u2028 \u2029 \${placeholder}</script>${icon}<svg class="other">different</svg>${icon}`;
    const plugin = docsVirtualModule([{ ...route("docs"), html }]);
    const iconSource = plugin.load.handler.call(null, "\0virtual:rom-weaver-docs-html") as string;
    const source = plugin.load.handler.call(null, `${PAGE_ID_PREFIX}docs`) as string;
    expect(source).not.toContain("<");
    expect(source).not.toContain(">");
    const loaded = await load(
      source.replace(
        '"virtual:rom-weaver-docs-html"',
        JSON.stringify(`data:text/javascript,${encodeURIComponent(iconSource)}`),
      ),
    );
    expect(loaded.html).toBe(html);
  });
});
