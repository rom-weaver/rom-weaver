import { BookOpen, ChevronUp, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createLogger } from "../lib/logging.ts";
import { DocsDrawerNav, docShelfFor } from "./docs-navigation.tsx";

const logger = createLogger("docs-bar");
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

type DocsBarRoute = {
  label: string;
  sections: readonly { id: string; label: string }[];
  slug: string;
};
type Overlay = "docs" | "parts" | null;

/** A swipe has to travel this far before it closes the drawer or steps back a level. */
const SWIPE_CLOSE_PX = 80;
const SWIPE_BACK_PX = 70;

/**
 * Where each section starts along the page, as a fraction of the scrollable
 * height, plus how far the reader has scrolled. Both feed the thread drawn
 * along the bar's top edge.
 */
const useReadingThread = (sections: DocsBarRoute["sections"]) => {
  const [thread, setThread] = useState<{ knots: number[]; read: number }>({ knots: [], read: 0 });
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      if (scrollable <= 0) {
        setThread({ knots: sections.map(() => 0), read: 1 });
        return;
      }
      const knots = sections.map(({ id }) => {
        const heading = document.getElementById(id);
        if (!heading) return 0;
        const top = heading.getBoundingClientRect().top + window.scrollY - window.innerHeight / 3;
        return Math.min(1, Math.max(0, top / scrollable));
      });
      setThread({ knots, read: Math.min(1, window.scrollY / scrollable) });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [sections]);
  return thread;
};

/**
 * The phone docs bar, docked above the app dock. The left half names the shelf,
 * the part, and the section being read, and opens this page's parts; the right
 * half opens the library drawer and turns into its Close button. Both overlays
 * rise from the bar so every control stays in thumb reach.
 */
const DocsBar = ({ activeIndex, route }: { activeIndex: number; route: DocsBarRoute }) => {
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [openShelf, setOpenShelf] = useState<string | null>(null);
  const partsButtonRef = useRef<HTMLButtonElement | null>(null);
  const docsButtonRef = useRef<HTMLButtonElement | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);
  const partsRef = useRef<HTMLElement | null>(null);
  const sectionRef = useRef<HTMLSpanElement | null>(null);
  const [longSection, setLongSection] = useState(false);
  const barRef = useRef<HTMLDivElement | null>(null);
  const [barHeight, setBarHeight] = useState<number | null>(null);
  const shelf = docShelfFor(route.slug);
  const { knots, read } = useReadingThread(route.sections);
  const hasParts = route.sections.length > 0;
  const partCount = route.sections.length + 1;
  const sectionLabel = activeIndex < 0 ? "Introduction" : (route.sections[activeIndex]?.label ?? "Introduction");

  const close = useCallback(() => {
    if (overlay === "parts") partsButtonRef.current?.focus();
    if (overlay === "docs") docsButtonRef.current?.focus();
    setOverlay(null);
  }, [overlay]);
  const toggle = (next: Exclude<Overlay, null>) => {
    logger.trace("Docs bar overlay toggled", { next, slug: route.slug });
    if (overlay === next) {
      close();
      return;
    }
    setOpenShelf(null);
    setOverlay(next);
  };

  useEffect(() => {
    if (!overlay) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (overlay === "docs" && openShelf) setOpenShelf(null);
      else close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [close, openShelf, overlay]);

  // The dock opens Menu and the settings console over this layer; neither should reveal a stale overlay when it closes.
  useEffect(() => {
    if (!overlay) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(".dock")) setOverlay(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [overlay]);

  // Focus follows the panel that just appeared, so keyboard and screen reader users land inside it.
  useEffect(() => {
    if (overlay === "parts")
      partsRef.current?.querySelector<HTMLElement>("[aria-current], a")?.focus({ preventScroll: true });
  }, [overlay]);
  useEffect(() => {
    if (overlay !== "docs") return;
    const target = openShelf ? ".docs-drawer-back" : ".docs-row.is-here, .docs-audience button";
    drawerRef.current?.querySelector<HTMLElement>(target)?.focus({ preventScroll: true });
  }, [overlay, openShelf]);

  // A section that needs three lines steps its type down one size, so the bar stays two lines tall at most.
  useIsomorphicLayoutEffect(() => {
    const text = sectionRef.current;
    if (!text) return;
    setLongSection(false);
    const lineHeight = Number.parseFloat(getComputedStyle(text).lineHeight) || 18;
    setLongSection(text.getBoundingClientRect().height > lineHeight * 2.5);
  }, [sectionLabel]);

  // The overlays sit on the bar's top edge, and a long section makes the bar taller than its CSS default.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return undefined;
    const observer = new ResizeObserver(() => setBarHeight(bar.offsetHeight || null));
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);

  const swipe = useRef<{ axis: "x" | "y" | null; x: number; y: number; atTop: boolean } | null>(null);
  const onTouchStart = (event: React.TouchEvent<HTMLElement>) => {
    const touch = event.touches[0];
    if (!touch) return;
    const scroller = event.currentTarget.querySelector<HTMLElement>(".docs-drawer-body");
    swipe.current = { atTop: (scroller?.scrollTop ?? 0) <= 0, axis: null, x: touch.clientX, y: touch.clientY };
  };
  const onTouchMove = (event: React.TouchEvent<HTMLElement>) => {
    const start = swipe.current;
    const touch = event.touches[0];
    if (!(start && touch) || start.axis) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.hypot(dx, dy) > 8) start.axis = Math.abs(dy) > Math.abs(dx) ? "y" : "x";
  };
  const onTouchEnd = (event: React.TouchEvent<HTMLElement>) => {
    const start = swipe.current;
    const touch = event.changedTouches[0];
    swipe.current = null;
    if (!(start && touch)) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (start.axis === "y" && start.atTop && dy > SWIPE_CLOSE_PX) close();
    else if (start.axis === "x" && openShelf && dx > SWIPE_BACK_PX) setOpenShelf(null);
  };

  const jumpTo = (id: string | null) => {
    close();
    if (!id) {
      window.scrollTo({ top: 0 });
      return;
    }
    document.getElementById(id)?.scrollIntoView({ block: "start" });
  };

  return (
    <div
      className="docs-bar-layer"
      style={barHeight ? ({ "--docs-bar-h": `${barHeight}px` } as React.CSSProperties) : undefined}
    >
      <button aria-label="Close" className="docs-bar-scrim" hidden={!overlay} onClick={close} type="button" />
      {hasParts ? (
        <section
          aria-label="On this page"
          className="docs-parts"
          hidden={overlay !== "parts"}
          id="docs-parts"
          ref={partsRef}
        >
          <p className="docs-parts-head">
            <span>{shelf?.title}</span>
            <span>{`${activeIndex + 2} of ${partCount}`}</span>
          </p>
          <ol>
            {[{ id: null, label: "Introduction" }, ...route.sections].map((part, index) => (
              <li key={part.id ?? "introduction"}>
                <a
                  aria-current={index - 1 === activeIndex ? "true" : undefined}
                  className={index - 1 < activeIndex ? "is-read" : undefined}
                  href={part.id ? `#${part.id}` : `/${route.slug}`}
                  onClick={(event) => {
                    event.preventDefault();
                    jumpTo(part.id);
                  }}
                >
                  {part.label}
                </a>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      <section
        aria-label="Docs"
        className="docs-drawer"
        hidden={overlay !== "docs"}
        id="docs-drawer"
        onTouchEnd={onTouchEnd}
        onTouchMove={onTouchMove}
        onTouchStart={onTouchStart}
        ref={drawerRef}
        role="dialog"
      >
        <div aria-hidden="true" className="docs-drawer-grab" />
        <div className="docs-drawer-body">
          {overlay === "docs" ? (
            <DocsDrawerNav
              currentSlug={route.slug}
              onNavigate={() => setOverlay(null)}
              onOpenShelf={setOpenShelf}
              openShelf={openShelf}
            />
          ) : null}
        </div>
      </section>
      <div className="docs-bar" ref={barRef}>
        {hasParts ? (
          <div aria-hidden="true" className="docs-bar-thread">
            <span className="docs-bar-thread-done" style={{ width: `${read * 100}%` }} />
            {knots.map((knot, index) => (
              <span
                className={index <= activeIndex ? "docs-bar-knot is-read" : "docs-bar-knot"}
                // biome-ignore lint/suspicious/noArrayIndexKey: one knot per section, in section order
                key={index}
                style={{ left: `${Math.min(98.5, Math.max(1.5, knot * 100))}%` }}
              />
            ))}
          </div>
        ) : null}
        <button
          aria-controls={hasParts ? "docs-parts" : undefined}
          aria-expanded={hasParts ? overlay === "parts" : undefined}
          className={longSection ? "docs-bar-where is-long" : "docs-bar-where"}
          disabled={!hasParts}
          onClick={() => toggle("parts")}
          ref={partsButtonRef}
          type="button"
        >
          <small>
            <span>{shelf?.title}</span>
            <span>{hasParts ? `${activeIndex + 2} of ${partCount}` : null}</span>
          </small>
          <span className="docs-bar-section" ref={sectionRef}>
            {hasParts ? sectionLabel : route.label}
          </span>
          {hasParts ? <ChevronUp aria-hidden="true" /> : null}
        </button>
        <button
          aria-controls="docs-drawer"
          aria-expanded={overlay === "docs"}
          className="docs-bar-open"
          onClick={() => toggle("docs")}
          ref={docsButtonRef}
          type="button"
        >
          {overlay === "docs" ? <X aria-hidden="true" /> : <BookOpen aria-hidden="true" />}
          {overlay === "docs" ? "Close" : "Docs"}
        </button>
      </div>
    </div>
  );
};

export { DocsBar };
