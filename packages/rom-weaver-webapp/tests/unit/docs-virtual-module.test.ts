import { describe, expect, it } from "vitest";
import { docsVirtualModule } from "../../scripts/docs-virtual-module.mjs";
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
