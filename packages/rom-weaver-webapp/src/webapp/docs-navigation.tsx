import { useEffect, useLayoutEffect, useRef } from "react";
import { DOC_SOURCES, docGroupTitle, groupDocNavigationRoutes } from "./docs-routing.mjs";
import { preloadDocsRouteHtml } from "./workflow-routes.tsx";
import { useDocShelfState, type DocShelfState } from "./use-doc-shelf-state.ts";

const DOC_SHELVES = groupDocNavigationRoutes(
  DOC_SOURCES.map((source) => ({ ...source, group: source.group ?? docGroupTitle(source.file) })),
);
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
const warmDocsHtml = (slug: string) => {
  void preloadDocsRouteHtml(slug).catch(() => undefined);
};

/** Compact task groups, independent of the source documentation folders. */
const DocsNav = ({
  currentSlug,
  onNavigate,
  onShelfToggle,
  openShelves,
  onSelectOverview,
  overviewId,
}: {
  currentSlug: string;
  onNavigate?: () => void;
  onShelfToggle: (title: string, open: boolean) => void;
  openShelves: DocShelfState;
  onSelectOverview?: () => void;
  overviewId?: string;
}) => {
  const navRef = useRef<HTMLElement | null>(null);
  const positionedSlug = useRef<string | null>(null);
  useIsomorphicLayoutEffect(() => {
    const nav = navRef.current;
    const scrollport = nav?.closest<HTMLElement>(".side-rail, .menu-sheet-body");
    if (!(nav && scrollport) || positionedSlug.current === currentSlug) return;
    const current = nav.querySelector<HTMLAnchorElement>('a[aria-current="page"]');
    if (!current) {
      positionedSlug.current = null;
      return;
    }
    const shelf = current.closest<HTMLDetailsElement>("details");
    if (shelf && !shelf.open) return;
    // The outer navigation MUST own scrolling, including revealing the active guide.
    const observer = new ResizeObserver(() => positionCurrentGuide());
    const positionCurrentGuide = () => {
      if (!scrollport.clientHeight) return;
      const linkBounds = current.getBoundingClientRect();
      const portBounds = scrollport.getBoundingClientRect();
      if (linkBounds.top < portBounds.top || linkBounds.bottom > portBounds.bottom) {
        scrollport.scrollTop += linkBounds.top - portBounds.top - (scrollport.clientHeight - linkBounds.height) / 2;
      }
      positionedSlug.current = currentSlug;
      observer.disconnect();
    };
    observer.observe(scrollport);
    positionCurrentGuide();
    return () => observer.disconnect();
  }, [currentSlug, openShelves]);
  const renderLinks = (routes: (typeof DOC_SHELVES)[number]["routes"], key?: string, grouped = false) =>
    routes.length ? (
      <ul className="guide-nav-list" key={key}>
        {routes.map((entry) => (
          <li key={entry.slug}>
            <a
              aria-current={entry.slug === currentSlug ? "page" : undefined}
              href={`/${entry.slug}`}
              id={entry.slug === "docs" ? overviewId : undefined}
              aria-label={grouped ? entry.label : undefined}
              onClick={(event) => {
                onNavigate?.();
                if (entry.slug !== "docs" || !onSelectOverview) return;
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                onSelectOverview();
              }}
              onFocus={() => warmDocsHtml(entry.slug)}
              onPointerEnter={() => warmDocsHtml(entry.slug)}
            >
              {grouped ? entry.label.replace(/ \((browser|CLI)\)$/, "") : entry.label}
            </a>
          </li>
        ))}
      </ul>
    ) : null;
  return (
    <nav aria-label="Docs" className="guide-nav" ref={navRef}>
      {DOC_SHELVES.map((shelf) =>
        shelf.title === "Start here" ? (
          renderLinks(shelf.routes, shelf.title)
        ) : (
          <details
            className="guide-shelf"
            key={shelf.title}
            onToggle={(event) => onShelfToggle(shelf.title, event.currentTarget.open)}
            open={openShelves[shelf.title]}
          >
            <summary>
              <h3 className="guide-shelf-title">{shelf.title}</h3>
            </summary>
            {shelf.routes.some((entry) => entry.audience) ? (
              <>
                {(["browser", "cli"] as const).map((audience) => {
                  const routes = shelf.routes.filter((entry) => entry.audience === audience);
                  if (!routes.length) return null;
                  return (
                    <div key={audience} className="guide-audience">
                      <h4 className="guide-audience-title">{audience === "browser" ? "Browser" : "CLI"}</h4>
                      {renderLinks(routes, undefined, true)}
                    </div>
                  );
                })}
                {renderLinks(shelf.routes.filter((entry) => !entry.audience))}
              </>
            ) : (
              renderLinks(shelf.routes)
            )}
          </details>
        ),
      )}
    </nav>
  );
};

const DocsNavigation = ({
  currentSlug,
  onNavigate,
  onSelectOverview,
  overviewId,
}: {
  currentSlug: string;
  onNavigate?: () => void;
  onSelectOverview?: () => void;
  overviewId?: string;
}) => {
  const { onShelfToggle, openShelves } = useDocShelfState(DOC_SHELVES);
  useEffect(() => {
    const shelf = DOC_SHELVES.find((entry) => entry.routes.some((route) => route.slug === currentSlug));
    if (shelf) onShelfToggle(shelf.title, true);
  }, [currentSlug, onShelfToggle]);
  return (
    <DocsNav
      currentSlug={currentSlug}
      onNavigate={onNavigate}
      onSelectOverview={onSelectOverview}
      overviewId={overviewId}
      onShelfToggle={onShelfToggle}
      openShelves={openShelves}
    />
  );
};

export { DocsNavigation };
