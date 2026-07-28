// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { DOC_ROUTES } from "virtual:rom-weaver-docs";
import { beforeEach, describe, expect, it } from "vitest";
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
      { file: "fixture.md", label: "Fixture", slug: "docs/fixture" },
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
