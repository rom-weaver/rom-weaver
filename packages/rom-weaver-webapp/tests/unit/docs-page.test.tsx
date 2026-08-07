// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { DOC_PAGE_LOADERS, DOC_ROUTES } from "virtual:rom-weaver-docs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDocRoute } from "../../src/webapp/docs-content.mjs";
import { DocsPage, preloadDocsHtml } from "../../src/webapp/docs-page.tsx";
import { SITE_ORIGIN } from "../../src/webapp/docs-routing.mjs";

// Guide HTML ships as one lazy chunk per page; rendering a guide synchronously
// requires its HTML resolved first, exactly as the app preloads before mount.
beforeAll(async () => {
  await Promise.all(DOC_ROUTES.map((route) => preloadDocsHtml(route.slug)));
});

const BUNDLE_GUIDE_ANCHORS = [
  "choose-what-to-include",
  "build-the-patch-recipe",
  "turn-on-bundle-output-and-download-it",
  "test-the-finished-download",
  "publish-a-useful-release",
  "open-a-hosted-bundle-in-apply",
];

const routeFor = (slug: string) => {
  const route = DOC_ROUTES.find((entry) => entry.slug === slug);
  if (!route) throw new Error(`no docs route for ${slug}`);
  return route;
};

const shelfTitles = [...new Set(DOC_ROUTES.map((route) => route.group))];
const defaultShelfTitle = DOC_ROUTES[0]?.group;
const shelfFor = (shelves: HTMLDetailsElement[], title: string) =>
  shelves.find((shelf) => shelf.querySelector(".guide-shelf-title, .docs-index-title")?.textContent === title);

const setSeoMetadata = (title: string, description: string, canonicalUrl: string) => {
  document.title = title;
  document.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute("content", description);
  document.querySelector<HTMLMetaElement>('meta[property="og:type"]')?.setAttribute("content", "website");
  document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.setAttribute("href", canonicalUrl);
};

describe("DocsPage", () => {
  beforeEach(() => {
    sessionStorage.clear();
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
  afterEach(() => {
    window.history.replaceState({}, "", "/");
    vi.restoreAllMocks();
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

  it("does not render the guided sample CTA", () => {
    render(<DocsPage active slug="docs" />);

    expect(document.querySelector(".docs-cta")).toBeNull();
    expect(screen.queryByRole("link", { name: "Guided Apply" })).toBeNull();
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

  it("keeps links between published guide sections pointed at real anchors", async () => {
    const routes = new Map(DOC_ROUTES.map((route) => [`/${route.slug}`, route]));
    const htmlOf = new Map(
      await Promise.all(
        DOC_ROUTES.map(async (route) => [route.slug, (await DOC_PAGE_LOADERS[route.slug]()).html] as const),
      ),
    );
    for (const route of DOC_ROUTES) {
      const source = document.createElement("template");
      source.innerHTML = htmlOf.get(route.slug) ?? "";
      for (const link of source.content.querySelectorAll<HTMLAnchorElement>("a[href*='#']")) {
        const targetUrl = new URL(link.getAttribute("href") ?? "", SITE_ORIGIN);
        const targetRoute = routes.get(targetUrl.pathname);
        if (!(targetRoute && targetUrl.hash)) continue;

        const target = document.createElement("template");
        target.innerHTML = htmlOf.get(targetRoute.slug) ?? "";
        const ids = [...target.content.querySelectorAll<HTMLElement>("[id]")].map((element) => element.id);
        expect(ids, `${route.slug} links to missing ${targetUrl.pathname}${targetUrl.hash}`).toContain(
          decodeURIComponent(targetUrl.hash.slice(1)),
        );
      }
    }
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
      { file: "how-to/fixture.md", label: "Fixture", slug: "docs/fixture" },
      `# Fixture

Fixture description.

## A &amp; \`B\`

[Formats](../explanation/patch-formats.md#ips) and [this section](#a-and-b).

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
    expect(route.html).toContain('<h2 id="a-and-b"><a class="docs-section-link" href="/docs/fixture#a-and-b">');
    expect(route.html).toContain('<h2 id="a-and-b-1"><a class="docs-section-link" href="/docs/fixture#a-and-b-1">');
    expect(route.html).toContain('<span class="docs-section-title">A &amp; <code>B</code></span></a></h2>');
    expect(route.html).toContain('class="docs-section-link-icon"');
  });

  // A markdown link inside a section heading would nest an <a> inside the
  // heading's own self-link, and the HTML parser splits nested anchors.
  it("unwraps markdown links inside section headings to their label text", () => {
    const route = createDocRoute(
      { file: "how-to/fixture.md", label: "Fixture", slug: "docs/fixture" },
      `# Fixture

Fixture description.

## See [chd](../explanation/compression-formats.md) details
`,
    );

    expect(route.sections).toEqual([{ id: "see-chd-details", label: "See chd details" }]);
    expect(route.html).toContain('<span class="docs-section-title">See chd details</span>');
    expect(route.html.slice(route.html.indexOf("<h2"))).not.toContain("compression-formats");
  });

  it("drops raw HTML from headings before rendering them", () => {
    const route = createDocRoute(
      { file: "how-to/fixture.md", label: "Fixture", slug: "docs/fixture" },
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
      { file: "how-to/fixture.md", label: "Fixture", slug: "docs/fixture" },
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

  it("publishes the browser bundle guide as one topic with self-linked sections", () => {
    render(<DocsPage active slug="docs/create-bundles" />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Create and share a patch bundle in the browser" }),
    ).toBeTruthy();
    expect(document.querySelectorAll(".docs-article > h2 > .docs-section-link")).toHaveLength(
      routeFor("docs/create-bundles").sections.length,
    );
    expect(document.querySelectorAll(".docs-article details.docs-disclosure")).toHaveLength(0);
  });

  it.each([
    ["docs/apply-rom-patches", 4],
    ["docs/create-rom-patches", 4],
    ["docs/create-bundles", 2],
  ])("reserves responsive screenshot space and keeps WebP fallbacks on %s", (slug, expectedPictures) => {
    render(<DocsPage active slug={slug} />);

    const pictures = [...document.querySelectorAll<HTMLPictureElement>("picture[data-docs-screenshot-theme]")];
    expect(pictures).toHaveLength(expectedPictures);
    for (const picture of pictures) {
      const image = picture.querySelector("img");
      const sources = [...picture.querySelectorAll("source")];
      expect(image?.getAttribute("src")).toMatch(/\.webp$/);
      expect(image?.getAttribute("loading")).toBeNull();
      expect(image?.getAttribute("decoding")).toBeNull();
      expect(Number(image?.getAttribute("width"))).toBeGreaterThan(0);
      expect(Number(image?.getAttribute("height"))).toBeGreaterThan(0);
      expect(sources.map((source) => source.getAttribute("type"))).toContain("image/avif");
      expect(sources.map((source) => source.getAttribute("type"))).toContain("image/webp");
      for (const source of sources) {
        expect(Number(source.getAttribute("width"))).toBeGreaterThan(0);
        expect(Number(source.getAttribute("height"))).toBeGreaterThan(0);
      }
    }
  });

  it("loads the tutorial screenshots before they enter the viewport", () => {
    render(<DocsPage active slug="docs/get-started" />);

    const images = [...document.querySelectorAll<HTMLImageElement>(".docs-article img")];
    expect(images).toHaveLength(2);
    for (const image of images) {
      expect(image.getAttribute("loading")).toBeNull();
      expect(image.getAttribute("decoding")).toBeNull();
      expect(Number(image.getAttribute("width"))).toBeGreaterThan(0);
      expect(Number(image.getAttribute("height"))).toBeGreaterThan(0);
    }
  });

  it("resolves hosted documents, repository-only documents, and published images from their source file", () => {
    const route = createDocRoute(
      { file: "how-to/fixture.md", label: "Fixture", slug: "docs/fixture" },
      `# Fixture

Fixture description.

## Resources

[Install](../reference/cli.md#install)
[Maintainer notes](../development/mobile-safari-verification.md)
![Sample](../screenshots/first-sample-modified-world.webp)
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

  it("shelves every route and keeps disclosure choices between pages", async () => {
    const { unmount } = render(<DocsPage active slug="docs/cli" />);

    const nav = document.querySelector(".docs-rails .guide-nav");
    expect(defaultShelfTitle).toBe("Start here");
    expect([...(nav?.querySelectorAll(".guide-shelf-title") ?? [])].map((shelf) => shelf.textContent)).toEqual(
      shelfTitles,
    );
    // Every published route reaches the nav, so a new guide can never be
    // stranded off the shelves.
    expect(nav?.querySelectorAll(".guide-nav-list a")).toHaveLength(DOC_ROUTES.length);
    expect(nav?.querySelector('a[aria-current="page"]')?.textContent).toBe("CLI reference");
    const shelves = [...(nav?.querySelectorAll<HTMLDetailsElement>(".guide-shelf") ?? [])];
    expect(shelves.map((shelf) => shelf.open)).toEqual(shelfTitles.map((title) => title === defaultShelfTitle));
    const hostingShelf = shelfFor(shelves, routeFor("docs/self-hosting").group);
    fireEvent.click(hostingShelf?.querySelector("summary") as HTMLElement);
    expect(hostingShelf?.open).toBe(true);

    unmount();
    render(<DocsPage active slug="docs/privacy" />);
    await vi.waitFor(() => {
      const currentShelves = [...document.querySelectorAll<HTMLDetailsElement>(".docs-rails .guide-shelf")];
      const openTitles = new Set(
        currentShelves
          .filter((shelf) => shelf.open)
          .map((shelf) => shelf.querySelector(".guide-shelf-title")?.textContent),
      );
      expect(openTitles).toEqual(new Set([defaultShelfTitle, routeFor("docs/self-hosting").group]));
    });
  });

  it("sends the reader back to the top of a guide from the end of it", () => {
    const scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);
    render(<DocsPage active slug="docs/apply-rom-patches" />);

    fireEvent.click(screen.getByRole("button", { name: "Back to top" }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
    vi.unstubAllGlobals();
  });

  it("lists browser, CLI, installation, and self-hosting paths, and previews the FAQ", () => {
    render(<DocsPage active slug="docs" />);

    const index = document.querySelector(".docs-index");
    expect(screen.getAllByRole("combobox", { name: "Search documentation" })).toHaveLength(2);
    expect(index?.querySelector('a[href="/docs/get-started"]')?.textContent).toContain(
      "Apply your first patch (browser)",
    );
    expect(index?.querySelector('a[href="/docs/cli-get-started"]')?.textContent).toContain(
      "Apply your first patch (CLI)",
    );
    expect(index?.querySelector('a[href="/docs/cli"]')?.textContent).toContain("CLI reference");
    expect(index?.querySelector('a[href="/docs/install"]')?.textContent).toContain("Install the CLI");
    expect(index?.querySelector('a[href="/docs/self-hosting"]')?.textContent).toContain("Self-hosting");
    expect(screen.getByRole("link", { name: "Read the full FAQ" }).getAttribute("href")).toBe("/docs/faq");
    expect(screen.getByText("Do my files get uploaded?")).toBeTruthy();
  });

  it("fuzzy-searches guide text and links directly to the matching section", async () => {
    render(<DocsPage active slug="docs" />);

    const input = screen.getAllByRole("combobox", { name: "Search documentation" })[0] as HTMLInputElement;
    fireEvent.change(input, { target: { value: "checksumm warning" } });

    const section = routeFor("docs/fix-checksum-errors").sections.find(
      (entry) => entry.id === "what-does-the-warning-mean",
    );
    expect(section).toBeTruthy();
    // The search index is a lazy chunk fetched on the first keystroke, so the
    // results fill in once it lands.
    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLAnchorElement>(
          `.docs-search-results a[href^="/docs/fix-checksum-errors?highlight="][href$="#${section?.id}"]`,
        ),
      ).toBeTruthy(),
    );
    expect(screen.getByRole("status").textContent).toMatch(/result/);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    expect((input as HTMLInputElement).value).toBe("");
    expect(document.querySelector(".guide-shelf")).toBeTruthy();
  });

  it("plays the page turn only after the reader changes guide", () => {
    // The first article is the prerendered document, so fading it in would push
    // the largest paint back by the length of the animation.
    const { rerender } = render(<DocsPage active slug="docs/cli" />);
    expect(document.querySelector(".docs-article")?.getAttribute("data-page-turn")).toBeNull();

    rerender(<DocsPage active slug="docs/faq" />);
    expect(document.querySelector(".docs-article")?.getAttribute("data-page-turn")).toBe("true");
  });

  it("opens this guide's outline and every guide from the phone trail", () => {
    render(<DocsPage active slug="docs/cli" />);

    fireEvent.click(screen.getByRole("button", { name: "Contents" }));

    const sheet = document.querySelector(".rw-modal.guide-sheet");
    expect(sheet?.querySelector(".warp-rail")).toBeTruthy();
    expect(sheet?.querySelectorAll(".guide-nav .guide-nav-list a")).toHaveLength(DOC_ROUTES.length);
    expect(sheet?.querySelector('.guide-nav a[aria-current="page"]')?.textContent).toBe("CLI reference");

    // Choosing a guide has to take the sheet with it - the reader asked to leave.
    fireEvent.click(sheet?.querySelector(".guide-nav .guide-nav-list a") as HTMLElement);
    expect(document.querySelector(".rw-modal.guide-sheet")).toBeNull();
  });

  it("shares search state with the mobile search", async () => {
    render(<DocsPage active slug="docs" />);
    const inputs = screen.getAllByRole("combobox", { name: "Search documentation" });
    fireEvent.change(inputs.at(-1) as HTMLElement, { target: { value: "OPFS" } });

    // The search index is a lazy chunk fetched on the first keystroke.
    await vi.waitFor(() =>
      expect(document.querySelectorAll(".docs-trail .docs-search-results a[href*='#']").length).toBeGreaterThan(0),
    );
  });

  it("highlights and centers the selected search term in its section", async () => {
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    render(<DocsPage active slug="docs/apply-rom-patches" />);

    const input = screen.getAllByRole("combobox", { name: "Search documentation" })[0] as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Nintendo 64" } });
    await vi.waitFor(
      () =>
        expect(
          document.querySelector('.docs-search-results a[href*="apply-rom-patches"][href*="highlight="]'),
        ).toBeTruthy(),
      { timeout: 10_000 },
    );
    const link = document.querySelector<HTMLAnchorElement>(
      '.docs-search-results a[href*="apply-rom-patches"][href*="highlight="]',
    );
    fireEvent.click(link as HTMLAnchorElement);

    await vi.waitFor(() => expect(document.querySelector("mark.docs-search-highlight")?.textContent).toBe("Nintendo"));
    await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" }));
  });

  it("scrolls to a guide anchor after its article is ready", async () => {
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    const sectionId = routeFor("docs/patch-formats").sections[0]?.id;
    window.history.replaceState({}, "", `/docs/patch-formats#${sectionId}`);

    render(<DocsPage active slug="docs/patch-formats" />);

    await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" }));
  });

  it("ends a guide with the steps either side of it, and the way back up", () => {
    const index = DOC_ROUTES.findIndex((route) => route.slug === "docs/apply-rom-patches");
    render(<DocsPage active slug="docs/apply-rom-patches" />);

    const onward = document.querySelector(".docs-onward");
    const steps = Array.from(onward?.querySelectorAll<HTMLAnchorElement>(".docs-step") ?? []);
    expect(steps.map((step) => step.getAttribute("href"))).toEqual([
      `/${DOC_ROUTES[index - 1]?.slug}`,
      `/${DOC_ROUTES[index + 1]?.slug}`,
    ]);
    expect(onward?.querySelector(".docs-to-top")).toBeTruthy();
  });

  it("links each guide footer to its editable GitHub source", () => {
    render(<DocsPage active slug="docs/apply-rom-patches" />);

    const sourceLink = screen.getByRole("link", { name: "Suggest changes on GitHub" });
    expect(sourceLink.getAttribute("href")).toBe(
      "https://github.com/rom-weaver/rom-weaver/edit/main/docs/how-to/apply-rom-patches.md",
    );
  });

  it("holds the previous step's place on the first page rather than sliding next into it", () => {
    // The hub is route zero, so it has no previous. The empty span keeps Next
    // where Next belongs instead of letting it take the left-hand slot.
    render(<DocsPage active slug="docs" />);

    const onward = document.querySelector(".docs-onward");
    expect(onward?.firstElementChild?.className).toBe("docs-step-gap");
    const steps = Array.from(onward?.querySelectorAll<HTMLAnchorElement>(".docs-step") ?? []);
    expect(steps.map((step) => step.getAttribute("href"))).toEqual([`/${DOC_ROUTES[1]?.slug}`]);
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
        weft: (document.querySelector(".warp-gauge-weft") as HTMLElement | null)?.style.width,
      };
    };

    // Reading line is 108px, so the second heading (1000px) becomes current
    // once the page has scrolled just past 892.
    // The last section stays reachable at the scroll limit even though its
    // heading never crosses the reading line.
    const atLimit = readAt(4600);
    expect(atLimit.weft).toBe("100%");
  });

  it("indexes every other page on the hub, and no page on a guide", () => {
    const { unmount } = render(<DocsPage active slug="docs" />);

    const index = document.querySelector(".docs-index");
    const shelves = [...(index?.querySelectorAll<HTMLDetailsElement>(".docs-index-shelf") ?? [])];
    expect(shelves.map((shelf) => shelf.querySelector(".docs-index-title")?.textContent)).toEqual(shelfTitles);
    expect(shelves.map((shelf) => shelf.open)).toEqual(shelfTitles.map((title) => title === defaultShelfTitle));
    const cliShelf = shelfFor(shelves, routeFor("docs/cli").group);
    fireEvent.click(cliShelf?.querySelector("summary") as HTMLElement);
    expect(cliShelf?.open).toBe(true);
    // Everything but the hub itself, so the landing page never links to itself.
    expect(index?.querySelectorAll("a")).toHaveLength(DOC_ROUTES.length - 1);
    // Every card carries its own page's opening sentence, matched by the page it
    // links to rather than by position - the index order is not this test's point,
    // and asserting on "the first card" let a page ship someone else's blurb.
    for (const card of index?.querySelectorAll("a") ?? []) {
      const slug = card.getAttribute("href")?.slice(1) ?? "";
      expect(card.querySelector(".docs-index-blurb")?.textContent).toBe(routeFor(slug).description);
    }

    unmount();
    render(<DocsPage active slug="docs/cli" />);
    expect(document.querySelector(".docs-index")).toBeNull();
  });

  it("gives the index and the guide it points at their own descriptions", () => {
    // Both pages opened on the same sentence at first, which would have shipped
    // one meta description on two routes.
    const descriptions = DOC_ROUTES.map((route) => route.description);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });
});
