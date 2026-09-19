import "./design-system/docs-route.css";
import { ArrowUpToLine, ChevronLeft, ChevronRight, ListTree } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { DOC_PAGE_LOADERS, DOC_ROUTES } from "virtual:rom-weaver-docs";
import { copyToClipboard } from "../lib/clipboard.ts";
import { createLogger } from "../lib/logging.ts";
import { CHANNEL_BADGE } from "./build-channel.ts";
import { RelatedStrip } from "./components/related-strip.tsx";
import { useRomWeaverAssetBaseUrl } from "../public/react/settings-context.tsx";
import { createDocsSeoMetadata, groupDocRoutes, readDocsSlugFromPathname } from "./docs-routing.mjs";
import { findSearchToken } from "./docs-search.mjs";
import { AUTHORED_SAMPLE_BASE, retargetSampleUrls } from "./docs-sample-origin.ts";
import { GITHUB_URL } from "./project-links.ts";
import { useReadingProgress } from "./use-reading-progress.ts";

type DocRoute = (typeof DOC_ROUTES)[number];

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
const GITHUB_BASE_URL = GITHUB_URL.replace(/\/$/, "");

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

// The served document already carries the guide it is standing on: importing
// that guide's HTML chunk would fetch the same article a second time, up to
// 14 kB brotli on the largest page, on the path the route mount awaits.
// Adopting the parsed markup instead also makes hydration a guaranteed match,
// because the string React re-applies is the one the parser built. Guides the
// reader navigates to still load their own chunk.
const adoptPrerenderedDocsHtml = () => {
  if (typeof document === "undefined") return;
  const article = document.querySelector(".docs-article[data-markdown-source]");
  if (!article) return;
  const slug = resolveDocsSlug();
  if (article.getAttribute("data-markdown-source") !== findDocsRoute(slug).source) return;
  docsHtmlCache.set(slug, article.innerHTML);
};

adoptPrerenderedDocsHtml();

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

const useDocsHtml = (slug: string, active: boolean): string | undefined => {
  const cached = docsHtmlCache.get(slug);
  const [, forceRender] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    if (cached !== undefined) return;
    let live = true;
    preloadDocsHtml(slug).then(
      () => {
        if (live) forceRender();
      },
      () => {
        // A visible guide can recover from a stale chunk manifest by asking
        // the server for its prerendered route, which carries current assets.
        if (live && active && readDocsSlugFromPathname(window.location.pathname) === slug) {
          window.location.assign(window.location.href);
        }
      },
    );
    return () => {
      live = false;
    };
  }, [active, cached, slug]);
  return cached;
};

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

/** One outline entry: label and the weft pick that marks the read one. */
const OutlineLink = ({
  current,
  href,
  label,
  onNavigate,
}: {
  current: boolean;
  href: string;
  label: string;
  onNavigate?: () => void;
}) => (
  <a aria-current={current ? "true" : undefined} href={href} onClick={onNavigate}>
    <span aria-hidden="true" className="warp-pick" />
    {label}
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
}) => {
  // The server cannot measure a restored scroll position. At the top of a
  // freshly opened guide the first heading is the honest fallback, and using
  // it here keeps the marker painted through hydration instead of flashing in
  // after the first client measurement.
  const initialIndex = activeIndex < 0 && route.sections.length > 0 ? 0 : activeIndex;
  return (
    <nav aria-label="On this page" className={initializing ? "warp-rail is-initializing" : "warp-rail"}>
      <span className="warp-rail-title">On this page</span>
      <ol className="warp-rail-list">
        {route.sections.map((section, index) => (
          <li key={section.id}>
            <OutlineLink
              current={index === initialIndex}
              href={`/${route.slug}#${section.id}`}
              label={section.label}
              onNavigate={onNavigate}
            />
          </li>
        ))}
      </ol>
    </nav>
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
      <div className="docs-faq-item">
        <h3>Do my files get uploaded?</h3>
        <p>No. The webapp reads, patches, and writes files on your device.</p>
      </div>
      <div className="docs-faq-item">
        <h3>Which patch format should I use?</h3>
        <p>Applying a patch? Use the file you were given. Creating one? BPS is a good cartridge default.</p>
      </div>
      <div className="docs-faq-item">
        <h3>Why does my ROM not match?</h3>
        <p>The region, revision, header, byte order, archive entry, or patch order differs from the author's file.</p>
      </div>
    </div>
  </section>
);

const TrailRow = ({
  buttonRef,
  onToggle,
  menuOpen,
}: {
  buttonRef: { current: HTMLButtonElement | null };
  onToggle: () => void;
  menuOpen: boolean;
}) => (
  <div className="docs-trail-row">
    <button
      aria-controls="docs-contents-menu"
      aria-expanded={menuOpen}
      className="docs-trail-menu"
      onClick={onToggle}
      ref={buttonRef}
      type="button"
    >
      <ListTree aria-hidden="true" />
      <span>Contents</span>
    </button>
  </div>
);

const TrailHead = ({
  activeIndex,
  initializing,
  route,
}: {
  activeIndex: number;
  initializing: boolean;
  route: DocRoute;
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const trailRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const outlined = route.sections.length > 0;

  useEffect(() => {
    if (!menuOpen) return undefined;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeMenu();
      menuButtonRef.current?.focus();
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && trailRef.current?.contains(event.target)) return;
      closeMenu();
    };
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [closeMenu, menuOpen]);

  return (
    <div className="docs-trail" ref={trailRef}>
      <TrailRow buttonRef={menuButtonRef} onToggle={() => setMenuOpen((open) => !open)} menuOpen={menuOpen} />
      {menuOpen ? (
        <aside aria-label="Documentation contents" className="docs-contents-menu" id="docs-contents-menu">
          {outlined ? (
            <SectionRail activeIndex={activeIndex} initializing={initializing} onNavigate={closeMenu} route={route} />
          ) : null}
        </aside>
      ) : null}
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
    data-direction={direction}
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
const ArticleEnd = ({ onSelectTab, slug }: { onSelectTab?: (id: string) => void; slug: string }) => {
  const route = findDocsRoute(slug);
  const previous = docsNeighbour(slug, -1);
  const next = docsNeighbour(slug, 1);
  return (
    <footer className="docs-footer">
      <nav aria-label="Guide pages" className="docs-onward">
        {previous ? <OnwardLink direction="previous" route={previous} /> : <span className="docs-step-gap" />}
        {/* Scroll without changing the URL fragment; scrollTo honors the page scroll behavior. */}
        <button className="docs-to-top" onClick={() => window.scrollTo({ top: 0 })} type="button">
          <ArrowUpToLine aria-hidden="true" />
          Back to top
        </button>
        {next ? <OnwardLink direction="next" route={next} /> : <span className="docs-step-gap" />}
      </nav>
      <a
        className="docs-source-link"
        href={`${GITHUB_BASE_URL}/edit/main/${route.source}`}
        rel="noreferrer"
        target="_blank"
      >
        Suggest changes on GitHub
      </a>
      {onSelectTab ? <RelatedStrip entryKey={route.slug} onSelectTab={onSelectTab} /> : null}
    </footer>
  );
};

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

const setDocsCopyState = (button: HTMLButtonElement, state: "copied" | "failed" | null) => {
  if (state) button.dataset.copyState = state;
  else delete button.dataset.copyState;
  const label = button.querySelector<HTMLElement>("[data-docs-copy-label]");
  if (label) label.textContent = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "";
  button.title = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy code";
  button.setAttribute("aria-label", state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy code");
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
  onSelectTab,
  slug,
}: {
  active: boolean;
  onSelectTab?: (id: string) => void;
  slug: string;
}) => {
  const targetRoute = findDocsRoute(slug);
  const targetHtml = useDocsHtml(targetRoute.slug, active);
  // The reader stays on the guide they can see: a navigation to a page whose
  // HTML chunk is still downloading keeps the current article (and its rails,
  // outline, and metadata) until the new one is ready to paint whole.
  const lastReadyRoute = useRef(targetRoute);
  if (targetHtml !== undefined) lastReadyRoute.current = targetRoute;
  const route = targetHtml === undefined ? lastReadyRoute.current : targetRoute;
  const routeHtml = docsHtmlCache.get(route.slug) ?? "";
  const hub = route.slug === HUB_SLUG;
  // One subscription for the page: the desktop rail and phone contents sheet
  // use the same active section.
  const { activeIndex, initializing } = useReadingProgress(route.sections, active);
  const pageTurned = useDocsPageTurned(route.slug);
  const { onShelfToggle, openShelves } = useDocShelfState();
  const assetBaseUrl = useRomWeaverAssetBaseUrl();
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
    if (!(active && html)) return undefined;
    const article = document.querySelector<HTMLElement>(".docs-article");
    if (!article) return undefined;
    const timers = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>();
    const buttons = [...article.querySelectorAll<HTMLElement>("[data-docs-copy-container]")].map((container) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "docs-copy-button";
      button.dataset.docsCopy = "";
      button.title = "Copy code";
      button.setAttribute("aria-label", "Copy code");
      button.innerHTML =
        '<svg aria-hidden="true" class="docs-copy-icon" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewBox="0 0 24 24"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg><svg aria-hidden="true" class="docs-copy-check" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewBox="0 0 24 24"><path d="m20 6-11 11-5-5"></path></svg><span class="sr-only" data-docs-copy-label aria-live="polite"></span>';
      container.prepend(button);
      return button;
    });
    const scheduleReset = (button: HTMLButtonElement, delay: number) => {
      const previous = timers.get(button);
      if (previous) clearTimeout(previous);
      const timer = setTimeout(() => {
        timers.delete(button);
        setDocsCopyState(button, null);
      }, delay);
      timers.set(button, timer);
    };
    const handlers = buttons.map((button) => {
      const handleClick = () => {
        const value = button.closest(".docs-code-block")?.querySelector("code")?.textContent ?? "";
        if (!value) return;
        copyToClipboard(value).then(
          () => {
            setDocsCopyState(button, "copied");
            scheduleReset(button, 1100);
          },
          (error) => {
            logger.trace("Documentation code copy failed", { message: String(error) });
            setDocsCopyState(button, "failed");
            scheduleReset(button, 1600);
          },
        );
      };
      button.addEventListener("click", handleClick);
      return () => button.removeEventListener("click", handleClick);
    });
    return () => {
      for (const cleanup of handlers) cleanup();
      for (const timer of timers.values()) clearTimeout(timer);
      for (const button of buttons) button.remove();
    };
  }, [active, html]);
  useEffect(() => {
    if (!active) return;
    syncDocsSeoMetadata(route);
  }, [active, route]);
  useEffect(() => setSampleBase(assetBaseUrl || AUTHORED_SAMPLE_BASE), [assetBaseUrl]);
  const highlight = readDocsHighlight(route.slug);
  useEffect(() => {
    if (!active) return;
    setHighlightQuery(highlight.query);
    setHighlightSection(highlight.sectionId);
  }, [active, highlight.query, highlight.sectionId]);
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
  useEffect(() => {
    if (!(active && html && window.location.hash)) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(decodeURIComponent(window.location.hash.slice(1)))?.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, html]);
  return (
    <div className="docs-workbench" id="main">
      {/* Keyed on the route so moving to another guide closes the sheet with it,
          rather than leaving it open over a guide it no longer describes. */}
      {route.sections.length > 0 ? (
        <TrailHead activeIndex={activeIndex} initializing={initializing} key={route.slug} route={route} />
      ) : null}
      <div className={route.sections.length > 0 ? "docs-layout" : "docs-layout docs-layout-full"}>
        {route.sections.length > 0 ? (
          <div className="docs-rails">
            <SectionRail activeIndex={activeIndex} initializing={initializing} route={route} />
          </div>
        ) : null}
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
          {hub ? <DocsFaqPreview /> : null}
          {hub ? <DocsIndex currentSlug={route.slug} onShelfToggle={onShelfToggle} openShelves={openShelves} /> : null}
          <ArticleEnd onSelectTab={onSelectTab} slug={route.slug} />
        </section>
      </div>
    </div>
  );
};

const DocsNavigation = ({ currentSlug, onNavigate }: { currentSlug: string; onNavigate?: () => void }) => {
  const { onShelfToggle, openShelves } = useDocShelfState();
  useEffect(() => {
    const shelf = DOC_SHELVES.find((entry) => entry.routes.some((route) => route.slug === currentSlug));
    if (shelf) onShelfToggle(shelf.title, true);
  }, [currentSlug, onShelfToggle]);
  return (
    <DocsNav
      currentSlug={currentSlug}
      onNavigate={onNavigate}
      onShelfToggle={onShelfToggle}
      openShelves={openShelves}
    />
  );
};

export { DocsNavigation, DocsPage, preloadDocsHtml };
