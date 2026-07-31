import "./design-system/docs-route.css";
import { ArrowUpToLine } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { DOC_ROUTES } from "virtual:rom-weaver-docs";
import { CHANNEL_BADGE } from "./build-channel.ts";
import { GUIDED_SAMPLE_HREFS, type GuidedSample } from "../public/react/guided-sample-start.ts";
import { useRomWeaverAssetBaseUrl } from "../public/react/settings-context.tsx";
import { createDocsSeoMetadata, groupDocRoutes } from "./docs-routing.mjs";
import { createDocsSearchIndex, findSearchToken, searchDocs } from "./docs-search.mjs";
import { AUTHORED_SAMPLE_BASE, retargetSampleUrls } from "./docs-sample-origin.ts";
import { useReadingProgress } from "./use-reading-progress.ts";

type DocRoute = (typeof DOC_ROUTES)[number];
type DocSearchRoute = ReturnType<typeof createDocsSearchIndex>[number];
type DocSearchResult = ReturnType<typeof searchDocs>[number];

/** Shelves are fixed at build time; the route table never changes at runtime. */
const DOC_SHELVES = groupDocRoutes(DOC_ROUTES);
const DOC_SHELF_STATE_KEY = "rom-weaver-docs-shelves";
type DocShelfState = Record<string, boolean>;
const DEFAULT_DOC_SHELF_STATE = Object.fromEntries(
  DOC_SHELVES.map((shelf) => [shelf.title, shelf.title === "Browser usage"]),
) as DocShelfState;

const readDocShelfState = (): DocShelfState => {
  try {
    const stored = JSON.parse(sessionStorage.getItem(DOC_SHELF_STATE_KEY) || "{}") as Record<string, unknown>;
    return Object.fromEntries(
      DOC_SHELVES.map((shelf) => [
        shelf.title,
        typeof stored[shelf.title] === "boolean" ? stored[shelf.title] : DEFAULT_DOC_SHELF_STATE[shelf.title],
      ]),
    ) as DocShelfState;
  } catch {
    return DEFAULT_DOC_SHELF_STATE;
  }
};

const useDocShelfState = () => {
  const [openShelves, setOpenShelves] = useState(DEFAULT_DOC_SHELF_STATE);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setOpenShelves(readDocShelfState());
    setReady(true);
  }, []);
  const onShelfToggle = useCallback(
    (title: string, open: boolean) => {
      if (!ready) return;
      setOpenShelves((current) => {
        if (current[title] === open) return current;
        const next = { ...current, [title]: open };
        try {
          sessionStorage.setItem(DOC_SHELF_STATE_KEY, JSON.stringify(next));
        } catch {
          // The menu still works when storage is blocked.
        }
        return next;
      });
    },
    [ready],
  );
  return { onShelfToggle, openShelves };
};

/** The landing route: an index of the guides rather than one of them. */
const HUB_SLUG = "docs";

const syncDocsSeoMetadata = (route: DocRoute) => {
  const { canonicalUrl, metadata, title } = createDocsSeoMetadata(route, CHANNEL_BADGE);
  document.title = title;
  for (const [attribute, name, content] of metadata) {
    document.querySelector<HTMLMetaElement>(`meta[${attribute}="${name}"]`)?.setAttribute("content", content);
  }
  document.querySelector<HTMLMetaElement>('meta[property="og:type"]')?.setAttribute("content", "article");
  document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.setAttribute("href", canonicalUrl);
};

const findDocsRoute = (slug: string) => {
  const route = DOC_ROUTES.find((entry) => entry.slug === slug) ?? DOC_ROUTES.at(0);
  if (!route) throw new Error("Docs must define at least one route");
  return route;
};

const sectionNumber = (index: number) => String(index + 1).padStart(2, "0");

/** One outline entry: index, label, and the weft pick that marks the read one. */
const OutlineLink = ({
  current,
  href,
  index,
  label,
  onNavigate,
}: {
  current: boolean;
  href: string;
  index: number;
  label: string;
  onNavigate?: () => void;
}) => (
  <a aria-current={current ? "true" : undefined} href={href} onClick={onNavigate}>
    <span aria-hidden="true" className="warp-pick" />
    <span aria-hidden="true" className="warp-index">
      {sectionNumber(index)}
    </span>
    <span className="warp-label">{label}</span>
  </a>
);

/**
 * The warp: the lengthwise threads a piece is woven on. A guide's section order
 * is its own structural axis, so the rail carries the outline and marks the
 * section being read with a weft pick crossing the warp line.
 */
const SectionRail = ({
  activeIndex,
  route,
  onNavigate,
}: {
  activeIndex: number;
  route: DocRoute;
  onNavigate?: () => void;
}) => (
  <nav aria-label="On this page" className="warp-rail">
    <span className="warp-rail-title">On this page</span>
    <ol className="warp-rail-list">
      {route.sections.map((section, index) => (
        <li key={section.id}>
          <OutlineLink
            current={index === activeIndex}
            href={`/${route.slug}#${section.id}`}
            index={index}
            label={section.label}
            onNavigate={onNavigate}
          />
        </li>
      ))}
    </ol>
  </nav>
);

const DocsSearch = ({
  onNavigate,
  onSelect,
  onQueryChange,
  query,
  results,
}: {
  onNavigate?: () => void;
  onSelect?: (result: DocSearchResult, query: string) => void;
  onQueryChange: (query: string) => void;
  query: string;
  results: readonly DocSearchResult[];
}) => {
  const inputId = useId();
  const resultListId = `${inputId}-results`;
  const statusId = `${inputId}-status`;
  const [activeIndex, setActiveIndex] = useState(-1);
  const [open, setOpen] = useState(false);
  const hasQuery = query.trim().length > 0;
  const showResults = hasQuery && open;

  useEffect(() => {
    if (query !== "") setActiveIndex(-1);
    if (query === "") setOpen(false);
  }, [query]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onQueryChange("");
      setOpen(false);
      return;
    }
    if (!results.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => (current <= 0 ? results.length - 1 : current - 1));
    } else if (event.key === "Enter" && activeIndex >= 0) {
      event.preventDefault();
      document.getElementById(`${resultListId}-${activeIndex}`)?.click();
    }
  };

  return (
    <div className="docs-search">
      <input
        aria-activedescendant={activeIndex >= 0 ? `${resultListId}-${activeIndex}` : undefined}
        aria-controls={resultListId}
        aria-describedby={statusId}
        aria-expanded={showResults}
        aria-label="Search documentation"
        autoComplete="off"
        className="input"
        id={inputId}
        onChange={(event) => {
          setOpen(true);
          onQueryChange(event.currentTarget.value);
        }}
        onKeyDown={onKeyDown}
        onFocus={() => setOpen(true)}
        placeholder="Search docs"
        role="combobox"
        type="search"
        value={query}
      />
      {showResults ? (
        <div className="docs-search-results">
          <p aria-live="polite" className="docs-search-status" id={statusId} role="status">
            {results.length === 0
              ? "No matching documentation."
              : `${results.length} ${results.length === 1 ? "result" : "results"}`}
          </p>
          {results.length > 0 ? (
            <ul className="guide-nav-list docs-search-result-list" id={resultListId}>
              {results.map((result, index) => {
                const highlight = new URLSearchParams({ highlight: query.trim() });
                const href = `/${result.route.slug}?${highlight}${result.entry.id ? `#${result.entry.id}` : ""}`;
                return (
                  <li key={`${result.route.slug}:${result.entry.id ?? "introduction"}`}>
                    <a
                      aria-label={`${result.entry.label}, ${result.route.title}`}
                      className={index === activeIndex ? "is-active" : undefined}
                      href={href}
                      id={`${resultListId}-${index}`}
                      onClick={() => {
                        onSelect?.(result, query);
                        onQueryChange("");
                        setOpen(false);
                        onNavigate?.();
                      }}
                    >
                      <strong className="docs-search-result-title">{result.entry.label}</strong>
                      <small>in {result.route.title}</small>
                      <small>{result.snippet}</small>
                    </a>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

/** Every page, on the shelf its folder puts it on. */
const DocsNav = ({
  currentSlug,
  onNavigate,
  onShelfToggle,
  openShelves,
}: {
  currentSlug: string;
  onNavigate?: () => void;
  onShelfToggle: (title: string, open: boolean) => void;
  openShelves: DocShelfState;
}) => (
  <nav aria-label="Docs" className="guide-nav">
    <span className="guide-nav-title">Docs</span>
    {DOC_SHELVES.map((shelf) => (
      <details
        className="guide-shelf"
        key={shelf.title}
        onToggle={(event) => onShelfToggle(shelf.title, event.currentTarget.open)}
        open={openShelves[shelf.title]}
      >
        <summary>
          <h3 className="guide-shelf-title">{shelf.title}</h3>
        </summary>
        <ul className="guide-nav-list">
          {shelf.routes.map((entry) => (
            <li key={entry.slug}>
              <a
                aria-current={entry.slug === currentSlug ? "page" : undefined}
                href={`/${entry.slug}`}
                onClick={onNavigate}
              >
                {entry.label}
              </a>
            </li>
          ))}
        </ul>
      </details>
    ))}
  </nav>
);

/** Every page and its opening sentence, grouped by audience and kept in route order. */
const DocsIndex = ({
  currentSlug,
  onShelfToggle,
  openShelves,
}: {
  currentSlug: string;
  onShelfToggle: (title: string, open: boolean) => void;
  openShelves: DocShelfState;
}) => (
  <nav aria-label="All documentation" className="docs-index">
    {DOC_SHELVES.map((shelf) => {
      const routes = shelf.routes.filter((entry) => entry.slug !== currentSlug);
      return (
        <details
          className="docs-index-shelf"
          key={shelf.title}
          onToggle={(event) => onShelfToggle(shelf.title, event.currentTarget.open)}
          open={openShelves[shelf.title]}
        >
          <summary>
            <h2 className="docs-index-title">{shelf.title}</h2>
            <span className="docs-index-count">{`${routes.length} ${routes.length === 1 ? "page" : "pages"}`}</span>
          </summary>
          <ul>
            {routes.map((entry) => (
              <li key={entry.slug}>
                <a href={`/${entry.slug}`}>
                  <span className="docs-index-label">{entry.label}</span>
                  <span className="docs-index-blurb">{entry.description}</span>
                </a>
              </li>
            ))}
          </ul>
        </details>
      );
    })}
  </nav>
);

const DocsFaqPreview = () => (
  <section aria-labelledby="docs-faq-title" className="docs-faq-preview">
    <div className="docs-faq-heading">
      <h2 id="docs-faq-title">Quick answers</h2>
      <a href="/docs/faq">Read the full FAQ</a>
    </div>
    <div className="docs-faq-list">
      <details>
        <summary>Do my files get uploaded?</summary>
        <p>No. The webapp reads, patches, and writes files on your device.</p>
      </details>
      <details>
        <summary>Which patch format should I use?</summary>
        <p>Applying a patch? Use the file you were given. Creating one? BPS is a good cartridge default.</p>
      </details>
      <details>
        <summary>Why does my ROM not match?</summary>
        <p>The region, revision, header, byte order, archive entry, or patch order differs from the author's file.</p>
      </details>
    </div>
  </section>
);

/** Which list the tapped crumb promised; null while the sheet is shut. */
/**
 * The trail: phone-width search and reading progress.
 *
 * It sticks to the top rather than holding the bottom of the screen. The
 * bottom is where the phone browser parks its own collapsing toolbar.
 *
 * The gauge remains attached to the search surface so the reader can still see
 * where they are in a long guide without carrying another navigation label.
 */
const TrailHead = ({
  fraction,
  onSearchSelect,
  onSearchQueryChange,
  route,
  searchQuery,
  searchResults,
  weights,
}: {
  fraction: number;
  onSearchSelect: (result: DocSearchResult, query: string) => void;
  onSearchQueryChange: (query: string) => void;
  route: DocRoute;
  searchQuery: string;
  searchResults: readonly DocSearchResult[];
  weights: readonly number[];
}) => {
  const outlined = route.sections.length > 0;

  return (
    <div className="docs-trail">
      <div className="docs-trail-search">
        <DocsSearch
          onQueryChange={onSearchQueryChange}
          onSelect={onSearchSelect}
          query={searchQuery}
          results={searchResults}
        />
      </div>
      {outlined ? (
        <span aria-hidden="true" className="warp-gauge">
          {route.sections.map((section, index) => (
            <i key={section.id} style={{ flexGrow: weights[index] ?? 1 }} />
          ))}
          <span className="warp-gauge-weft" style={{ width: `${fraction * 100}%` }} />
        </span>
      ) : null}
    </div>
  );
};

/**
 * The way back up, at the end of the guide.
 *
 * Deliberately the only thing here. Onward links are already the last paragraph
 * of every guide, hand-written and pointing at whatever actually follows from
 * what you just read - "Ready to make your own? See Create a patch." An
 * auto-generated previous/next pair sat one screen under that saying the same
 * thing worse: shelf-adjacent is not the same as logically next, and on the
 * first guide it duplicated a link the prose had just made.
 */
const ArticleEnd = () => (
  <div className="docs-onward">
    {/* A button, not an `#top` anchor: the guide routes are paths, and a hash here
        would leave a destination in the address bar that is not one. `scrollTo`
        still picks up the page's own `scroll-behavior`. */}
    <button className="docs-to-top" onClick={() => window.scrollTo({ top: 0 })} type="button">
      <ArrowUpToLine aria-hidden="true" />
      Back to top
    </button>
  </div>
);

const isPlainLeftClick = (event: MouseEvent<HTMLAnchorElement>) =>
  event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
const ignoreGuide = (_guide: GuidedSample) => undefined;

const readDocsHighlight = (routeSlug?: string) => {
  if (typeof window === "undefined") return { query: "", sectionId: null };
  const url = new URL(window.location.href);
  if (routeSlug && !url.pathname.replace(/\/$/, "").endsWith(`/${routeSlug}`)) {
    return { query: "", sectionId: null };
  }
  return {
    query: url.searchParams.get("highlight") ?? "",
    sectionId: url.hash ? decodeURIComponent(url.hash.slice(1)) : null,
  };
};

const clearDocsHighlightParam = () => {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has("highlight")) return;
  url.searchParams.delete("highlight");
  window.history.replaceState(window.history.state, "", url);
};

const highlightDocsTerm = (article: HTMLElement, query: string, sectionId: string | null) => {
  for (const mark of article.querySelectorAll("mark.docs-search-highlight")) {
    mark.replaceWith(document.createTextNode(mark.textContent ?? ""));
  }
  const heading = sectionId ? document.getElementById(sectionId) : null;
  const nextHeading = heading
    ? [...article.querySelectorAll("h2")].find(
        (candidate) => heading.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING,
      )
    : null;
  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const textNode = node as Text;
    const parent = textNode.parentElement;
    const afterHeading =
      !heading ||
      (parent &&
        (heading === parent || Boolean(heading.compareDocumentPosition(parent) & Node.DOCUMENT_POSITION_FOLLOWING)));
    const beforeNextHeading =
      !nextHeading ||
      (parent &&
        (nextHeading === parent ||
          Boolean(nextHeading.compareDocumentPosition(parent) & Node.DOCUMENT_POSITION_PRECEDING)));
    if (parent && afterHeading && beforeNextHeading) textNodes.push(textNode);
    node = walker.nextNode();
  }
  for (const textNode of textNodes) {
    const match = findSearchToken(textNode.nodeValue ?? "", query);
    if (!match) continue;
    const mark = document.createElement("mark");
    mark.className = "docs-search-highlight";
    const range = document.createRange();
    range.setStart(textNode, match.index);
    range.setEnd(textNode, match.index + match.text.length);
    range.surroundContents(mark);
    return mark;
  }
  return null;
};

const DocsPage = ({
  active,
  onGuideIntent = ignoreGuide,
  onStartGuide = ignoreGuide,
  slug,
}: {
  active: boolean;
  onGuideIntent?: (guide: GuidedSample) => void;
  onStartGuide?: (guide: GuidedSample) => boolean | void;
  slug: string;
}) => {
  const route = findDocsRoute(slug);
  const hub = route.slug === HUB_SLUG;
  // One subscription for the page: the desktop rail and the phone trail read the
  // same position, and the hook measures the document on every scroll frame.
  const { activeIndex, fraction, weights } = useReadingProgress(route.sections, active);
  const { onShelfToggle, openShelves } = useDocShelfState();
  const assetBaseUrl = useRomWeaverAssetBaseUrl();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState<readonly DocSearchRoute[]>([]);
  const searchResults = useMemo(() => searchDocs(searchIndex, searchQuery), [searchIndex, searchQuery]);
  const initialHighlight = readDocsHighlight();
  const [highlightQuery, setHighlightQuery] = useState(initialHighlight.query);
  const [highlightSection, setHighlightSection] = useState<string | null>(initialHighlight.sectionId);
  // Starts on the base the guides are authored against, which is what the
  // served document was rendered with, so hydration has nothing to reconcile.
  // The deployment's own base applies after mount, and only re-renders the
  // guides where the two differ.
  const [sampleBase, setSampleBase] = useState(AUTHORED_SAMPLE_BASE);
  const html = useMemo(() => retargetSampleUrls(route.html, sampleBase), [route, sampleBase]);
  useEffect(() => {
    if (!active) return;
    syncDocsSeoMetadata(route);
  }, [active, route]);
  useEffect(() => {
    if (!active) {
      setSearchIndex([]);
      setSearchQuery("");
      return;
    }
    setSearchIndex(createDocsSearchIndex(DOC_ROUTES));
  }, [active]);
  useEffect(() => setSampleBase(assetBaseUrl || AUTHORED_SAMPLE_BASE), [assetBaseUrl]);
  useEffect(() => {
    if (!active) return;
    const highlight = readDocsHighlight(route.slug);
    setHighlightQuery(highlight.query);
    setHighlightSection(highlight.sectionId);
  }, [active, route.slug]);
  useEffect(() => {
    if (!(active && highlightQuery && html)) return;
    const article = document.querySelector<HTMLElement>(".docs-article");
    if (!article) return;
    const mark = highlightDocsTerm(article, highlightQuery, highlightSection);
    const frame = window.requestAnimationFrame(() => {
      (mark ?? (highlightSection ? document.getElementById(highlightSection) : null))?.scrollIntoView({
        block: "center",
      });
      clearDocsHighlightParam();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, highlightQuery, highlightSection, html]);
  const onSearchSelect = useCallback((result: DocSearchResult, query: string) => {
    setHighlightQuery(query);
    setHighlightSection(result.entry.id);
  }, []);
  return (
    <div className="docs-workbench" id="main">
      <div className="docs-search-header">
        <DocsSearch
          onSelect={onSearchSelect}
          onQueryChange={setSearchQuery}
          query={searchQuery}
          results={searchResults}
        />
      </div>
      {/* Keyed on the route so moving to another guide closes the sheet with it,
          rather than leaving it open over a guide it no longer describes. */}
      <TrailHead
        fraction={fraction}
        key={route.slug}
        onSearchSelect={onSearchSelect}
        onSearchQueryChange={setSearchQuery}
        route={route}
        searchQuery={searchQuery}
        searchResults={searchResults}
        weights={weights}
      />
      <div className="docs-layout">
        <div className="docs-rails">
          <DocsNav currentSlug={route.slug} onShelfToggle={onShelfToggle} openShelves={openShelves} />
          {route.sections.length > 0 ? <SectionRail activeIndex={activeIndex} route={route} /> : null}
        </div>
        <section className="docs-panel">
          <article
            className="docs-article"
            data-markdown-source={route.source}
            // Committed repository Markdown, rendered to HTML at build time by
            // the same parser that feeds the prerendered page.
            // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted repository Markdown is the page source
            dangerouslySetInnerHTML={{ __html: html }}
          />
          {/* Hub only, and above the index rather than below it. Every guide
              each ending in the same three buttons made the pitch furniture
              rather than an offer, and every guide already closes on a link its
              author chose. */}
          {hub ? (
            <aside className="docs-cta">
              <div>
                <h2>Try rom-weaver</h2>
                <p>Learn Apply, Create, or Bundle with included homebrew files.</p>
              </div>
              <div className="docs-cta-actions">
                <a
                  className="btn primary"
                  href={GUIDED_SAMPLE_HREFS.apply}
                  onClick={(event) => {
                    if (!isPlainLeftClick(event)) return;
                    if (onStartGuide("apply") !== false) event.preventDefault();
                  }}
                  onFocus={() => onGuideIntent("apply")}
                  onPointerEnter={() => onGuideIntent("apply")}
                >
                  Guided Apply
                </a>
                <a
                  className="btn"
                  href={GUIDED_SAMPLE_HREFS.create}
                  onClick={(event) => {
                    if (!isPlainLeftClick(event)) return;
                    if (onStartGuide("create") !== false) event.preventDefault();
                  }}
                  onFocus={() => onGuideIntent("create")}
                  onPointerEnter={() => onGuideIntent("create")}
                >
                  Guided Create
                </a>
                <a
                  className="btn"
                  href={GUIDED_SAMPLE_HREFS.bundle}
                  onClick={(event) => {
                    if (!isPlainLeftClick(event)) return;
                    if (onStartGuide("bundle") !== false) event.preventDefault();
                  }}
                  onFocus={() => onGuideIntent("bundle")}
                  onPointerEnter={() => onGuideIntent("bundle")}
                >
                  Guided Bundle
                </a>
              </div>
            </aside>
          ) : null}
          {hub ? <DocsFaqPreview /> : null}
          {hub ? <DocsIndex currentSlug={route.slug} onShelfToggle={onShelfToggle} openShelves={openShelves} /> : null}
        </section>
      </div>
      <ArticleEnd />
    </div>
  );
};

export { DocsPage };
