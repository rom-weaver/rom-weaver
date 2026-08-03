import "./design-system/docs-route.css";
import { ArrowUpToLine, ChevronLeft, ChevronRight, ListTree } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { DOC_PAGE_LOADERS, DOC_ROUTES } from "virtual:rom-weaver-docs";
import type { DocSearchEntry } from "virtual:rom-weaver-docs-search";
import { createLogger } from "../lib/logging.ts";
import { CHANNEL_BADGE } from "./build-channel.ts";
import { Modal } from "../public/react/components/ds/modal.tsx";
import { GUIDED_SAMPLE_HREFS, type GuidedSample } from "../public/react/guided-sample-start.ts";
import { useRomWeaverAssetBaseUrl } from "../public/react/settings-context.tsx";
import { createDocsSeoMetadata, groupDocRoutes, readDocsSlugFromPathname } from "./docs-routing.mjs";
import { findSearchToken, searchDocs } from "./docs-search.mjs";
import { AUTHORED_SAMPLE_BASE, retargetSampleUrls } from "./docs-sample-origin.ts";
import { useReadingProgress } from "./use-reading-progress.ts";

type DocRoute = (typeof DOC_ROUTES)[number];
type DocSearchRoute = DocRoute & { searchEntries: readonly DocSearchEntry[] };
type DocSearchResult = ReturnType<typeof searchDocs>[number];

const logger = createLogger("docs-page");

/** Shelves are fixed at build time; the route table never changes at runtime. */
const DOC_SHELVES = groupDocRoutes(DOC_ROUTES);
const DOC_SHELF_STATE_KEY = "rom-weaver-docs-shelves";
type DocShelfState = Record<string, boolean>;
/** The first shelf opens by default: the map and the quick answers. */
const DEFAULT_DOC_SHELF = DOC_SHELVES[0]?.title ?? "";
const DEFAULT_DOC_SHELF_STATE = Object.fromEntries(
  DOC_SHELVES.map((shelf) => [shelf.title, shelf.title === DEFAULT_DOC_SHELF]),
) as DocShelfState;

// Read the persisted shelf state before the first client paint. The server
// keeps its deterministic default for hydration; the browser applies the
// reader's saved drawers without showing a closed-to-open reload transition.
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

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
  const [openShelves, setOpenShelves] = useState(readDocShelfState);
  const [ready, setReady] = useState(false);
  useIsomorphicLayoutEffect(() => {
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

/**
 * Each guide's HTML is its own lazy chunk (scripts/docs-virtual-module.mjs), so
 * a docs visit downloads the page being read instead of every guide at once.
 *
 * The cache is read synchronously during render, mirroring the workflow-routes
 * preload contract: a page resolved before its first render - the prerendered
 * landing guide, or a hover-warmed neighbour - never flashes empty. Prerender
 * and the client boot both await `preloadDocsHtml` before mounting a docs
 * document (see prerender-entry.tsx and webapp.ts), so hydration always finds
 * the article it is standing on.
 */
const docsHtmlCache = new Map<string, string>();
const docsHtmlPending = new Map<string, Promise<void>>();

const resolveDocsSlug = (slug?: string): string => {
  if (slug) return findDocsRoute(slug).slug;
  if (typeof window === "undefined") return HUB_SLUG;
  return findDocsRoute(readDocsSlugFromPathname(window.location.pathname)).slug;
};

const preloadDocsHtml = (slug?: string): Promise<void> => {
  const resolved = resolveDocsSlug(slug);
  if (docsHtmlCache.has(resolved)) return Promise.resolve();
  const pending = docsHtmlPending.get(resolved);
  if (pending) return pending;
  const loader = DOC_PAGE_LOADERS[resolved];
  if (!loader) return Promise.resolve();
  logger.trace("Docs page HTML requested", { slug: resolved });
  const load = loader().then(
    (module) => {
      docsHtmlPending.delete(resolved);
      docsHtmlCache.set(resolved, module.html);
      logger.trace("Docs page HTML loaded", { slug: resolved });
    },
    (error) => {
      // Dropped from `pending` so the next navigation to the page retries.
      docsHtmlPending.delete(resolved);
      logger.warn("Docs page HTML failed to load", {
        message: error instanceof Error ? error.message : String(error || ""),
        slug: resolved,
      });
      throw error;
    },
  );
  docsHtmlPending.set(resolved, load);
  return load;
};

/** Fire-and-forget warmup for link hover/focus; failures retry on navigation. */
const warmDocsHtml = (slug: string) => {
  void preloadDocsHtml(slug).catch(() => undefined);
};

const useDocsHtml = (slug: string): string | undefined => {
  const cached = docsHtmlCache.get(slug);
  const [, forceRender] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    if (cached !== undefined) return;
    let live = true;
    preloadDocsHtml(slug).then(
      () => {
        if (live) forceRender();
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [cached, slug]);
  return cached;
};

/** Joined once on demand: route metadata plus the prebuilt text entries of the lazy search chunk. */
let docsSearchIndexPromise: Promise<readonly DocSearchRoute[]> | null = null;

const loadDocsSearchIndex = (): Promise<readonly DocSearchRoute[]> => {
  docsSearchIndexPromise ??= import("virtual:rom-weaver-docs-search").then(
    ({ SEARCH_ENTRIES }) => DOC_ROUTES.map((route) => ({ ...route, searchEntries: SEARCH_ENTRIES[route.slug] ?? [] })),
    (error) => {
      // Cleared so the next search interaction retries the chunk.
      docsSearchIndexPromise = null;
      logger.warn("Docs search index failed to load", {
        message: error instanceof Error ? error.message : String(error || ""),
      });
      throw error;
    },
  );
  return docsSearchIndexPromise;
};

const sectionNumber = (index: number) => String(index + 1).padStart(2, "0");

/**
 * True once the reader has changed guide at least once.
 *
 * The article's entrance IS the page transition, and it must not play on the
 * first render: that article is the prerendered document, and fading it in
 * would push the largest paint back by the length of the animation.
 */
const useDocsPageTurned = (slug: string) => {
  const renderedSlug = useRef(slug);
  const turned = useRef(false);
  if (renderedSlug.current !== slug) {
    renderedSlug.current = slug;
    turned.current = true;
  }
  return turned.current;
};

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
  initializing,
  route,
  onNavigate,
}: {
  activeIndex: number;
  initializing: boolean;
  route: DocRoute;
  onNavigate?: () => void;
}) => (
  <nav aria-label="On this page" className={initializing ? "warp-rail is-initializing" : "warp-rail"}>
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
                      onFocus={() => warmDocsHtml(result.route.slug)}
                      onPointerEnter={() => warmDocsHtml(result.route.slug)}
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
                onFocus={() => warmDocsHtml(entry.slug)}
                onPointerEnter={() => warmDocsHtml(entry.slug)}
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
                <a
                  href={`/${entry.slug}`}
                  onFocus={() => warmDocsHtml(entry.slug)}
                  onPointerEnter={() => warmDocsHtml(entry.slug)}
                >
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

/**
 * The trail: phone-width navigation, search, and reading progress.
 *
 * It holds the bottom of the screen, immediately above the app's own dock, so
 * the two ways out of a guide - another guide, another mode - sit under the
 * same thumb. The desktop rails are the sidebar; here they are one sheet the
 * Contents button opens.
 *
 * The gauge rides the bar's top edge, which is the seam between the guide and
 * the chrome, so the reader can see where they are in a long guide without
 * carrying another navigation label.
 */
const TrailHead = ({
  activeIndex,
  fraction,
  initializing,
  onSearchSelect,
  onSearchQueryChange,
  onShelfToggle,
  openShelves,
  route,
  searchQuery,
  searchResults,
  weights,
}: {
  activeIndex: number;
  fraction: number;
  initializing: boolean;
  onSearchSelect: (result: DocSearchResult, query: string) => void;
  onSearchQueryChange: (query: string) => void;
  onShelfToggle: (title: string, open: boolean) => void;
  openShelves: DocShelfState;
  route: DocRoute;
  searchQuery: string;
  searchResults: readonly DocSearchResult[];
  weights: readonly number[];
}) => {
  const [sheetOpen, setSheetOpen] = useState(false);
  const closeSheet = useCallback(() => setSheetOpen(false), []);
  const outlined = route.sections.length > 0;

  return (
    <div className="docs-trail">
      {outlined ? (
        <span aria-hidden="true" className="warp-gauge">
          {route.sections.map((section, index) => (
            <i key={section.id} style={{ flexGrow: weights[index] ?? 1 }} />
          ))}
          <span className="warp-gauge-weft" style={{ width: `${fraction * 100}%` }} />
        </span>
      ) : null}
      <div className="docs-trail-row">
        <button
          aria-expanded={sheetOpen}
          className="docs-trail-menu"
          onClick={() => setSheetOpen((open) => !open)}
          type="button"
        >
          <ListTree aria-hidden="true" />
          <span>Contents</span>
        </button>
        <div className="docs-trail-search">
          <DocsSearch
            onNavigate={closeSheet}
            onQueryChange={onSearchQueryChange}
            onSelect={onSearchSelect}
            query={searchQuery}
            results={searchResults}
          />
        </div>
      </div>
      {/* Both lists at once: the outline the reader is inside, then every guide.
          Two separate sheets meant guessing which one a single button promised. */}
      <Modal onClose={closeSheet} open={sheetOpen} title={route.title} variant="guide-sheet">
        {outlined ? (
          <SectionRail activeIndex={activeIndex} initializing={initializing} onNavigate={closeSheet} route={route} />
        ) : null}
        <DocsNav
          currentSlug={route.slug}
          onNavigate={closeSheet}
          onShelfToggle={onShelfToggle}
          openShelves={openShelves}
        />
      </Modal>
    </div>
  );
};

/** Reading order is route order, which is the order the shelves themselves list. */
const docsNeighbour = (slug: string, step: -1 | 1) => {
  const index = DOC_ROUTES.findIndex((entry) => entry.slug === slug);
  return index < 0 ? undefined : DOC_ROUTES[index + step];
};

/** One end-of-guide step: the direction it goes, and the page it lands on. */
const OnwardLink = ({ direction, route }: { direction: "next" | "previous"; route: DocRoute }) => (
  <a
    aria-label={`${direction === "next" ? "Next" : "Previous"}: ${route.title}`}
    className="docs-step"
    href={`/${route.slug}`}
    onFocus={() => warmDocsHtml(route.slug)}
    onPointerEnter={() => warmDocsHtml(route.slug)}
  >
    {direction === "previous" ? <ChevronLeft aria-hidden="true" /> : null}
    <span className="docs-step-copy">
      <small>{direction === "next" ? "Next" : "Previous"}</small>
      <b>{route.label}</b>
    </span>
    {direction === "next" ? <ChevronRight aria-hidden="true" /> : null}
  </a>
);

/**
 * The end of the guide: the way on, the way back, and (on phones, where the
 * sidebar is not there to glance at) the way back up.
 *
 * Reading order is route order, so the pair is the shelf's own sequence. A guide
 * that closes on a hand-written onward link still keeps it - that link says why
 * to go somewhere, and these two say where you are in the sequence.
 */
const ArticleEnd = ({ slug }: { slug: string }) => {
  const previous = docsNeighbour(slug, -1);
  const next = docsNeighbour(slug, 1);
  return (
    <nav aria-label="Guide pages" className="docs-onward">
      {previous ? <OnwardLink direction="previous" route={previous} /> : <span className="docs-step-gap" />}
      {/* A button, not an `#top` anchor: the guide routes are paths, and a hash here
          would leave a destination in the address bar that is not one. `scrollTo`
          still picks up the page's own `scroll-behavior`. */}
      <button className="docs-to-top" onClick={() => window.scrollTo({ top: 0 })} type="button">
        <ArrowUpToLine aria-hidden="true" />
        Back to top
      </button>
      {next ? <OnwardLink direction="next" route={next} /> : <span className="docs-step-gap" />}
    </nav>
  );
};

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
  const targetRoute = findDocsRoute(slug);
  const targetHtml = useDocsHtml(targetRoute.slug);
  // The reader stays on the guide they can see: a navigation to a page whose
  // HTML chunk is still downloading keeps the current article (and its rails,
  // outline, and metadata) until the new one is ready to paint whole.
  const lastReadyRoute = useRef(targetRoute);
  if (targetHtml !== undefined) lastReadyRoute.current = targetRoute;
  const route = targetHtml === undefined ? lastReadyRoute.current : targetRoute;
  const routeHtml = docsHtmlCache.get(route.slug) ?? "";
  const hub = route.slug === HUB_SLUG;
  // One subscription for the page: the desktop rail and the phone trail read the
  // same position, and the hook measures the document on every scroll frame.
  const { activeIndex, fraction, initializing, weights } = useReadingProgress(route.sections, active);
  const pageTurned = useDocsPageTurned(route.slug);
  const { onShelfToggle, openShelves } = useDocShelfState();
  const assetBaseUrl = useRomWeaverAssetBaseUrl();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState<readonly DocSearchRoute[]>([]);
  const searchResults = useMemo(() => searchDocs(searchIndex, searchQuery), [searchIndex, searchQuery]);
  // The prebuilt index is its own lazy chunk, fetched the first time the
  // reader actually searches; results fill in when it lands.
  const onSearchQueryChange = useCallback((query: string) => {
    if (query.trim())
      void loadDocsSearchIndex()
        .then(setSearchIndex)
        .catch(() => undefined);
    setSearchQuery(query);
  }, []);
  const initialHighlight = readDocsHighlight();
  const [highlightQuery, setHighlightQuery] = useState(initialHighlight.query);
  const [highlightSection, setHighlightSection] = useState<string | null>(initialHighlight.sectionId);
  // Starts on the base the guides are authored against, which is what the
  // served document was rendered with, so hydration has nothing to reconcile.
  // The deployment's own base applies after mount, and only re-renders the
  // guides where the two differ.
  const [sampleBase, setSampleBase] = useState(AUTHORED_SAMPLE_BASE);
  const html = useMemo(() => retargetSampleUrls(routeHtml, sampleBase), [routeHtml, sampleBase]);
  useEffect(() => {
    if (!active) return;
    syncDocsSeoMetadata(route);
  }, [active, route]);
  useEffect(() => {
    if (!active) setSearchQuery("");
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
          onQueryChange={onSearchQueryChange}
          query={searchQuery}
          results={searchResults}
        />
      </div>
      {/* Keyed on the route so moving to another guide closes the sheet with it,
          rather than leaving it open over a guide it no longer describes. */}
      <TrailHead
        activeIndex={activeIndex}
        fraction={fraction}
        initializing={initializing}
        key={route.slug}
        onSearchSelect={onSearchSelect}
        onSearchQueryChange={onSearchQueryChange}
        onShelfToggle={onShelfToggle}
        openShelves={openShelves}
        route={route}
        searchQuery={searchQuery}
        searchResults={searchResults}
        weights={weights}
      />
      <div className="docs-layout">
        <div className="docs-rails">
          <DocsNav currentSlug={route.slug} onShelfToggle={onShelfToggle} openShelves={openShelves} />
          {route.sections.length > 0 ? (
            <SectionRail activeIndex={activeIndex} initializing={initializing} route={route} />
          ) : null}
        </div>
        <section className="docs-panel">
          {/* Keyed on the route so a guide switch remounts the article and
              replays its entrance - that animation IS the page transition. */}
          <article
            className="docs-article"
            key={route.slug}
            data-markdown-source={route.source}
            data-page-turn={pageTurned ? "true" : undefined}
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
          <ArticleEnd slug={route.slug} />
        </section>
      </div>
    </div>
  );
};

export { DocsPage, preloadDocsHtml };
