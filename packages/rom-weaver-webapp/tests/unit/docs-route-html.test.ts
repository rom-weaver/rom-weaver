import { describe, expect, it } from "vitest";
import { createDocRoute } from "../../src/webapp/docs-content.mjs";
import { createDocsRouteHtml, DOC_ROUTES } from "../../src/webapp/docs-pages.mjs";
import { createDocsSeoMetadata } from "../../src/webapp/docs-routing.mjs";

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

describe("documentation image paths", () => {
  const render = (body: string) =>
    createDocRoute(
      { file: "how-to/apply-patches.md", label: "Apply patches", slug: "docs/apply-patches" },
      `# Apply patches\n\nApply a patch to a ROM.\n\n${body}`,
    ).html;

  it("publishes relative raw HTML picture sources under the docs screenshot route", () => {
    const html = render(
      '<picture><source srcset="../screenshots/patch-form.webp 1x, ../screenshots/patch-form@2x.webp 2x"><img src="../screenshots/patch-form.png"></picture>',
    );

    expect(html).toContain(
      '<source srcset="/docs/screenshots/patch-form.webp 1x, /docs/screenshots/patch-form@2x.webp 2x">',
    );
    expect(html).toContain('<img src="/docs/screenshots/patch-form.png">');
  });

  it("keeps Markdown image rewriting unchanged", () => {
    expect(render("![Patch form](../screenshots/patch-form.png)")).toContain(
      '<img src="/docs/screenshots/patch-form.png" alt="Patch form">',
    );
  });

  it("does not rewrite external raw HTML image paths", () => {
    const html = render(
      '<picture><source srcset="https://example.com/patch.webp 1x"><img src="https://example.com/patch.png"></picture><script src="../screenshots/example.js"></script>',
    );

    expect(html).toContain('srcset="https://example.com/patch.webp 1x"');
    expect(html).toContain('src="https://example.com/patch.png"');
    expect(html).toContain('src="../screenshots/example.js"');
  });
});

describe("documentation descriptions", () => {
  const source = { file: "reference/example.md", label: "Example", slug: "docs/example" };

  it("uses prose instead of a Markdown table for the search description", () => {
    const result = createDocRoute(
      source,
      "# Example\n\n| System | Decoder |\n| --- | --- |\n| NES | Game Genie |\n\nSupported **cheat codes** for [ROMs](./roms.md).",
    );
    expect(result.description).toBe("Supported cheat codes for ROMs.");
  });

  it("rejects documents without a descriptive paragraph", () => {
    expect(() =>
      createDocRoute(source, "# Example\n\n| System | Decoder |\n| --- | --- |\n| NES | Game Genie |"),
    ).toThrow("must start with a descriptive paragraph");
  });
});

describe("documentation sample links", () => {
  const source = { file: "tutorials/example.md", label: "Example", slug: "docs/example" };

  it("serves repository practice files from the site at the same path", () => {
    const { html } = createDocRoute(
      source,
      "# Example\n\nIntro.\n\n[disc](../samples/compressed-disc/practice-disc.chd)\n[other](../samples/compressed-disc/missing.chd)\n",
    );
    expect(html).toContain('href="/docs/samples/compressed-disc/practice-disc.chd"');
    expect(html).toContain("/blob/main/docs/samples/compressed-disc/missing.chd");
  });

  it("keeps generated practice files and app routes on the current deployment", () => {
    const { html } = createDocRoute(
      source,
      "# Example\n\nIntro.\n\n[zip](https://rom-weaver.com/first-weave.zip)\n[app](https://rom-weaver.com/compress)\n",
    );
    expect(html).toContain('href="/first-weave.zip"');
    expect(html).toContain('href="/compress"');
    expect(html).not.toContain("https://rom-weaver.com");
  });
});

describe("published doc titles", () => {
  // SEO audits flag titles over 70 characters as likely to be truncated.
  it("keeps every production page title under 70 characters", () => {
    const tooLong = DOC_ROUTES.map((doc) => createDocsSeoMetadata(doc).title).filter((title) => title.length >= 70);
    expect(tooLong).toEqual([]);
  });
});
