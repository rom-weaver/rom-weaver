import { describe, expect, it } from "vitest";
import { createDocsRouteHtml } from "../../src/webapp/docs-pages.mjs";

const SHELL = [
  "<!doctype html>",
  "<html><head>",
  "<title>placeholder</title>",
  '<link rel="canonical" href="" />',
  '<meta property="og:type" content="website" />',
  '<meta name="description" content="" />',
  "</head><body></body></html>",
].join("\n");

const route = (overrides: Record<string, string> = {}) => ({
  description: "How to apply a patch.",
  slug: "docs/faq",
  title: "FAQ",
  ...overrides,
});

/** Read the JSON-LD payload the way the browser's HTML parser would. */
const readStructuredData = (html: string) => {
  const opening = '<script type="application/ld+json">';
  const start = html.indexOf(opening) + opening.length;
  return JSON.parse(html.slice(start, html.indexOf("</script>", start)));
};

describe("createDocsRouteHtml", () => {
  it("stamps the route's structured data into the shell", () => {
    const html = createDocsRouteHtml(SHELL, route(), "prod", "");
    expect(readStructuredData(html)).toMatchObject({ "@type": "TechArticle", headline: "FAQ" });
  });

  it("keeps guide text from closing the inline script", () => {
    const title = "FAQ</script><script>alert(1)</script>";
    const html = createDocsRouteHtml(SHELL, route({ title }), "prod", "");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(readStructuredData(html).headline).toBe(title);
  });
});
