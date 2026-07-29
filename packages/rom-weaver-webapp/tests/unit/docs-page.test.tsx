// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { DOC_ROUTES } from "virtual:rom-weaver-docs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDocRoute } from "../../src/webapp/docs-content.mjs";
import { DocsPage } from "../../src/webapp/docs-page.tsx";

const routeFor = (slug: string) => {
  const route = DOC_ROUTES.find((entry) => entry.slug === slug);
  if (!route) throw new Error(`no docs route for ${slug}`);
  return route;
};

const setSeoMetadata = (title: string, description: string, canonicalUrl: string) => {
  document.title = title;
  document.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute("content", description);
  document.querySelector<HTMLMetaElement>('meta[property="og:type"]')?.setAttribute("content", "website");
  document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.setAttribute("href", canonicalUrl);
};

describe("DocsPage", () => {
  beforeEach(() => {
    document.head.innerHTML = `
      <meta name="description" content="">
      <meta property="og:title" content="">
      <meta property="og:description" content="">
      <meta property="og:type" content="website">
      <meta property="og:url" content="">
      <meta name="twitter:title" content="">
      <meta name="twitter:description" content="">
      <link rel="canonical" href="">
    `;
  });
  afterEach(() => vi.restoreAllMocks());

  it("restores docs metadata when its kept-alive panel becomes active again", () => {
    const { rerender } = render(<DocsPage active slug="docs" />);
    const docsTitle = document.title;
    const docsDescription = document.querySelector('meta[name="description"]')?.getAttribute("content");
    expect(docsTitle).toMatch(new RegExp(`^${routeFor("docs").title} \\| rom-weaver`));
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe("https://rom-weaver.com/docs");

    rerender(<DocsPage active={false} slug="docs" />);
    setSeoMetadata(
      "rom-weaver — Create ROM patches online",
      "Create ROM patches locally in your browser.",
      "https://rom-weaver.com/create",
    );
    rerender(<DocsPage active slug="docs" />);

    expect(document.title).toBe(docsTitle);
    expect(document.querySelector('meta[name="description"]')?.getAttribute("content")).toBe(docsDescription);
    expect(document.querySelector('meta[property="og:type"]')?.getAttribute("content")).toBe("article");
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe("https://rom-weaver.com/docs");
  });

  it("builds the section rail from the guide's own headings and drops the generated outline", () => {
    render(<DocsPage active slug="docs/apply-rom-patches" />);

    const rail = screen.getByRole("navigation", { name: "On this page" });
    const railLinks = [...rail.querySelectorAll("a")];
    expect(railLinks.length).toBeGreaterThan(0);
    for (const link of railLinks) {
      const id = link.getAttribute("href")?.replace("/docs/apply-rom-patches#", "") ?? "";
      expect(document.querySelector(`h2[id="${id}"]`)).toBeTruthy();
    }
    // doctoc's in-file table of contents is for GitHub; the rail replaces it here.
    expect(screen.queryByRole("heading", { name: "Table of contents" })).toBeNull();
  });

  it("marks the final section current when the document reaches its scroll limit", async () => {
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(600);
    vi.spyOn(window, "scrollY", "get").mockReturnValue(1_000);
    vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(1_600);
    render(<DocsPage active slug="docs/create-rom-patches" />);

    const links = [...screen.getByRole("navigation", { name: "On this page" }).querySelectorAll("a")];
    await vi.waitFor(() => expect(links.at(-1)?.getAttribute("aria-current")).toBe("true"));
  });

  it("rewrites guide links to routes, including ones carrying an anchor", () => {
    render(<DocsPage active slug="docs/apply-rom-patches" />);

    const article = document.querySelector(".docs-article");
    const unrewritten = [...(article?.querySelectorAll("a[href]") ?? [])]
      .map((link) => link.getAttribute("href") ?? "")
      .filter((href) => !/^https?:/.test(href) && href.includes(".md"));
    expect(unrewritten).toEqual([]);
  });

  // Guides name the production origin so the Markdown reads on GitHub. A page
  // served from beta, nightly, or a PR preview must keep the reader on that
  // deployment, so every in-app link has to come out root-relative.
  it.each(DOC_ROUTES.map((route) => route.slug))("links within the deployment serving %s", (slug) => {
    render(<DocsPage active slug={slug} />);

    const article = document.querySelector(".docs-article");
    const offsite = [...(article?.querySelectorAll("a[href]") ?? [])]
      .map((link) => link.getAttribute("href") ?? "")
      .filter((href) => href.startsWith("https://rom-weaver.com"));
    expect(offsite).toEqual([]);
  });

  it("renders headings, links, and code through parser hooks", () => {
    const route = createDocRoute(
      { file: "guides/fixture.md", label: "Fixture", slug: "docs/fixture" },
      `# Fixture

Fixture description.

## A &amp; \`B\`

[Formats](patch-formats.md#ips) and [this section](#a-and-b).

## A &amp; \`B\`

\`\`\`sh
echo hi
\`\`\`
`,
    );

    expect(route.sections).toEqual([
      { id: "a-and-b", label: "A and B" },
      { id: "a-and-b-1", label: "A and B" },
    ]);
    expect(route.html).toContain('href="/docs/patch-formats#ips"');
    expect(route.html).toContain('href="/docs/fixture#a-and-b"');
    expect(route.html).toContain('<pre tabindex="0"><code class="language-sh">');
    expect(route.html).toContain(
      '<h2 id="a-and-b"><span aria-hidden="true" class="docs-section-index">01</span><span class="docs-section-title">A &amp; <code>B</code></span>',
    );
    expect(route.html).toContain(
      '<h2 id="a-and-b-1"><span aria-hidden="true" class="docs-section-index">02</span><span class="docs-section-title">A &amp; <code>B</code></span>',
    );
  });

  it("publishes the bundle guide as numbered, collapsible sections", () => {
    render(<DocsPage active slug="docs/create-bundles" />);

    expect(screen.getByRole("heading", { level: 1, name: "Create and share a patch bundle" })).toBeTruthy();
    expect(document.querySelectorAll(".docs-article > h2 .docs-section-index")).toHaveLength(
      routeFor("docs/create-bundles").sections.length,
    );
    expect(document.querySelectorAll(".docs-article details.docs-disclosure")).toHaveLength(
      routeFor("docs/create-bundles").sections.length,
    );
  });

  it("resolves hosted documents, repository-only documents, and published images from their source file", () => {
    const route = createDocRoute(
      { file: "guides/fixture.md", label: "Fixture", slug: "docs/fixture" },
      `# Fixture

Fixture description.

## Resources

[Install](../cli.md#install)
[Maintainer notes](../mobile-safari-verification.md)
![Sample](../../packages/rom-weaver-webapp/design/first-sample-modified-world.png)
`,
    );

    expect(route.html).toContain('href="/docs/cli#install"');
    expect(route.html).toContain(
      'href="https://github.com/rom-weaver/rom-weaver/blob/main/docs/mobile-safari-verification.md"',
    );
    expect(route.html).toContain('src="/docs/screenshots/first-sample-modified-world.png"');
  });

  it.each([
    ["docs/notices", "Notices"],
    ["docs/privacy", "Privacy"],
  ])("renders the %s page in the shared docs route", (slug, title) => {
    render(<DocsPage active slug={slug} />);

    expect(screen.getByRole("heading", { level: 1, name: title })).toBeTruthy();
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
      `https://rom-weaver.com/${slug}`,
    );
  });
});
