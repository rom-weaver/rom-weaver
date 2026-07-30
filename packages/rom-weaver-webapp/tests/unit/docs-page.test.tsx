// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { DOC_ROUTES } from "virtual:rom-weaver-docs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDocRoute } from "../../src/webapp/docs-content.mjs";
import { DocsPage } from "../../src/webapp/docs-page.tsx";
import { SITE_ORIGIN } from "../../src/webapp/docs-routing.mjs";

const BUNDLE_GUIDE_ANCHORS = [
  "decide-what-the-bundle-should-contain",
  "create-a-bundle-in-the-weave-webapp",
  "create-a-bundle-with-the-cli",
  "test-the-finished-bundle",
  "publish-and-link-the-bundle",
];

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
      .filter((href) => URL.canParse(href) && new URL(href).origin === SITE_ORIGIN);
    expect(offsite).toEqual([]);
  });

  it("renders headings, links, and code through parser hooks", () => {
    const route = createDocRoute(
      { file: "usage/fixture.md", label: "Fixture", slug: "docs/fixture" },
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

  it("drops raw HTML from headings before rendering them", () => {
    const route = createDocRoute(
      { file: "usage/fixture.md", label: "Fixture", slug: "docs/fixture" },
      `# Fixture

Fixture description.

## **Safe <script>alert(1)</script>**
`,
    );

    expect(route.sections).toEqual([{ id: "safe-alert1", label: "Safe alert(1)" }]);
    expect(route.html).toContain("<strong>Safe alert(1)</strong>");
    expect(route.html).not.toContain("<script>");
  });

  // Text inside a raw block is handed back verbatim on the assumption that the
  // tags around it survive. They do not in a heading, so it has to be escaped.
  it("escapes heading text that a dropped raw block would pass through", () => {
    const route = createDocRoute(
      { file: "usage/fixture.md", label: "Fixture", slug: "docs/fixture" },
      `# Fixture

Fixture description.

## <script>1 & 2 "3"</script>
`,
    );

    expect(route.sections).toEqual([{ id: "1-2-3", label: '1 & 2 "3"' }]);
    expect(route.html).toContain('<span class="docs-section-title">1 &amp; 2 &quot;3&quot;</span>');
  });

  // Section ids are the anchor URLs the published guides link to and that
  // readers bookmark, so a change to how headings are parsed must not move them.
  it.each(DOC_ROUTES.map((route) => route.slug))("derives usable section anchors for %s", (slug) => {
    const { sections } = routeFor(slug);
    const ids = sections.map((section) => section.id);

    expect(ids.filter((id) => !/^[\p{Letter}\p{Number}][\p{Letter}\p{Number}-]*$/u.test(id))).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(sections.filter((section) => !section.label.trim())).toEqual([]);
  });

  it("keeps the bundle guide's published anchors stable", () => {
    expect(routeFor("docs/create-bundles").sections.map((section) => section.id)).toEqual(BUNDLE_GUIDE_ANCHORS);
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
      { file: "usage/fixture.md", label: "Fixture", slug: "docs/fixture" },
      `# Fixture

Fixture description.

## Resources

[Install](../hosting/cli.md#install)
[Maintainer notes](../development/mobile-safari-verification.md)
![Sample](../../packages/rom-weaver-webapp/design/first-sample-modified-world.webp)
`,
    );

    expect(route.html).toContain('href="/docs/cli#install"');
    expect(route.html).toContain(
      'href="https://github.com/rom-weaver/rom-weaver/blob/main/docs/development/mobile-safari-verification.md"',
    );
    expect(route.html).toContain('src="/docs/screenshots/first-sample-modified-world.webp"');
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

  it("shelves every route under the folder it lives in", () => {
    render(<DocsPage active slug="docs/cli" />);

    const nav = document.querySelector(".docs-rails .guide-nav");
    expect([...(nav?.querySelectorAll(".guide-shelf-title") ?? [])].map((shelf) => shelf.textContent)).toEqual([
      "Usage",
      "Install & hosting",
      "Development",
      "Legal",
    ]);
    // Every published route reaches the nav, so a new guide can never be
    // stranded off the shelves.
    expect(nav?.querySelectorAll(".guide-nav-list a")).toHaveLength(DOC_ROUTES.length);
    expect(nav?.querySelector('a[aria-current="page"]')?.textContent).toBe("CLI and installation");
  });

  it("gives each trail crumb the list its own label promised", () => {
    render(<DocsPage active slug="docs/apply-rom-patches" />);

    const sections = routeFor("docs/apply-rom-patches").sections;
    // One warp tick per section: the gauge is the shape of the document.
    expect(document.querySelectorAll(".warp-gauge i")).toHaveLength(sections.length);

    // The section crumb opens this guide's outline, and nothing else.
    fireEvent.click(screen.getByRole("button", { name: /Open this guide's outline/ }));
    const outlineSheet = document.querySelector(".rw-modal.guide-sheet");
    expect(outlineSheet?.querySelectorAll(".warp-rail-list a")).toHaveLength(sections.length);
    expect(outlineSheet?.querySelector(".guide-nav-list")).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });

    // `Docs` opens every guide, and nothing else - tapping it and landing on this
    // guide's outline would break the promise the label made.
    fireEvent.click(screen.getByRole("button", { name: "Docs" }));
    const pagesSheet = document.querySelector(".rw-modal.guide-sheet");
    expect(pagesSheet?.querySelectorAll(".guide-nav-list a")).toHaveLength(DOC_ROUTES.length);
    expect(pagesSheet?.querySelector(".warp-rail-list")).toBeNull();
  });

  it("closes a guide with the guides either side of it, in shelf order", () => {
    render(<DocsPage active slug="docs/create-rom-patches" />);

    const onward = [...document.querySelectorAll(".docs-onward .onward-link")].map((link) => [
      link.querySelector(".onward-kind")?.textContent,
      link.getAttribute("href"),
    ]);
    expect(onward).toEqual([
      ["Previous guide", "/docs/apply-rom-patches"],
      ["Next guide", "/docs/create-bundles"],
    ]);
  });

  it("never offers the hub as a neighbouring guide", () => {
    // The first guide on the shelves sits directly after the hub, so an unfiltered
    // reading order would hand it "previous guide: Docs" - the parent these all
    // live under, and the trail's own `Docs` crumb is the way back to it.
    render(<DocsPage active slug="docs/apply-rom-patches" />);

    const onward = [...document.querySelectorAll(".docs-onward .onward-link")].map((link) => [
      link.querySelector(".onward-kind")?.textContent,
      link.getAttribute("href"),
    ]);
    expect(onward).toEqual([["Next guide", "/docs/create-rom-patches"]]);
  });

  it("sends the reader back to the top of a guide from the end of it", () => {
    const scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);
    render(<DocsPage active slug="docs/apply-rom-patches" />);

    fireEvent.click(screen.getByRole("button", { name: "Back to top" }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
    vi.unstubAllGlobals();
  });

  it("leaves the neighbour pair off the hub, which already lists every guide", () => {
    render(<DocsPage active slug="docs" />);

    expect(document.querySelector(".docs-onward .onward-link")).toBeNull();
    expect(screen.getByRole("button", { name: "Back to top" })).toBeTruthy();
  });

  it("tracks the reading position as the reader scrolls", () => {
    // happy-dom lays nothing out, so the geometry the hook reads is supplied
    // here: headings every 500px down a 5000px article.
    const SPACING = 500;
    let scrollTop = 0;
    const sections = routeFor("docs/apply-rom-patches").sections;
    vi.spyOn(window, "scrollY", "get").mockImplementation(() => scrollTop);
    // Stubbed by id, which is how the hook finds them.
    const layOutHeadings = () => {
      sections.forEach((section, index) => {
        const heading = document.getElementById(section.id);
        if (heading)
          heading.getBoundingClientRect = () => ({ bottom: 0, top: (index + 1) * SPACING - scrollTop }) as DOMRect;
      });
      const article = document.querySelector(".docs-article");
      if (article) article.getBoundingClientRect = () => ({ bottom: 5000 - scrollTop, top: 0 }) as DOMRect;
    };
    vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(5400);
    window.innerHeight = 800;
    // The hook reads inside an animation frame; run them inline so a scroll is
    // observable in the same tick. The handle must be 0: the callback runs
    // before the hook stores it, so a truthy one would latch its coalescing
    // guard and swallow every later scroll.
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);

    render(<DocsPage active slug="docs/apply-rom-patches" />);
    layOutHeadings();

    const readAt = (scrollY: number) => {
      scrollTop = scrollY;
      layOutHeadings();
      // Resize re-measures before reading; scroll alone reuses the cached
      // geometry, which was taken before these rects existed.
      fireEvent(window, new Event("resize"));
      return {
        index: document.querySelector(".trail-index")?.textContent,
        label: document.querySelector(".trail-label")?.textContent,
        weft: (document.querySelector(".warp-gauge-weft") as HTMLElement | null)?.style.width,
      };
    };

    // Reading line is 108px, so the second heading (1000px) becomes current
    // once the page has scrolled just past 892.
    expect(readAt(0).index).toBe("01");
    expect(readAt(950).index).toBe("02");
    expect(readAt(950).label).toBe(sections[1]?.label);
    // 2000 puts the fourth heading exactly on the line and leaves the fifth
    // 500px below it.
    expect(readAt(2000).index).toBe("04");
    // The last section stays reachable at the scroll limit even though its
    // heading never crosses the reading line.
    const atLimit = readAt(4600);
    expect(atLimit.index).toBe(String(sections.length).padStart(2, "0"));
    expect(atLimit.weft).toBe("100%");
  });

  it("indexes every other page on the hub, and no page on a guide", () => {
    const { unmount } = render(<DocsPage active slug="docs" />);

    const index = document.querySelector(".docs-index");
    expect([...(index?.querySelectorAll("h2") ?? [])].map((shelf) => shelf.textContent)).toEqual([
      "Usage",
      "Install & hosting",
      "Development",
      "Legal",
    ]);
    // Everything but the hub itself, so the landing page never links to itself.
    expect(index?.querySelectorAll("a")).toHaveLength(DOC_ROUTES.length - 1);
    expect(index?.querySelector(".docs-index-blurb")?.textContent).toBe(routeFor("docs/apply-rom-patches").description);

    unmount();
    render(<DocsPage active slug="docs/cli" />);
    expect(document.querySelector(".docs-index")).toBeNull();
  });
});
