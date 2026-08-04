import { describe, expect, it } from "vitest";
import { docsVirtualModule } from "../../scripts/docs-virtual-module.mjs";
import { DOC_SOURCES } from "../../src/webapp/docs-routing.mjs";

const METADATA_ID = "\0virtual:rom-weaver-docs";

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
