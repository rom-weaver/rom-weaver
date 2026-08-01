import { useEffect, useState } from "preact/hooks";

/**
 * How far into the document the reader is, and the shape of the document they
 * are moving through.
 *
 * `weights` is what makes the warp honest: one tick per section, each as wide
 * as that section is long. Because the ticks are proportional to real section
 * heights, a single continuous scroll fraction lands inside the correct tick on
 * its own - no second calculation, and no tick that claims a long section and a
 * two-line one are the same distance.
 */
type ReadingProgress = {
  /** Index of the section being read, or -1 before the first heading. */
  activeIndex: number;
  /** Document scroll position, 0 at the top and 1 at the scroll limit. */
  fraction: number;
  /** Each section's share of the document, summing to 1. */
  weights: readonly number[];
};

/** Reading line: a heading counts as current once it passes under the masthead. */
const HEADING_BAND_PX = 108;

const EMPTY: ReadingProgress = { activeIndex: -1, fraction: 0, weights: [] };

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

type Measurement = {
  /** Document offset of the first heading: where the outline, and the gauge, begin. */
  start: number;
  /** Document offset of the end of the article: where they both end. */
  end: number;
  weights: number[];
};

/**
 * Measure how much of the article each section spans. A section runs from its
 * own heading to the next one; the last runs to the end of the article.
 *
 * The weights and the scroll fraction have to be measured over the same span or
 * the weft crosses a tick boundary before the reader crosses the heading: the
 * front matter above the first heading and the call to action below the article
 * belong to neither.
 */
const measure = (sections: readonly { id: string }[]): Measurement => {
  const article = document.querySelector(".docs-article");
  const end = article ? article.getBoundingClientRect().bottom + window.scrollY : document.documentElement.scrollHeight;
  const tops = sections.map(({ id }) => {
    const heading = document.getElementById(id);
    return heading ? heading.getBoundingClientRect().top + window.scrollY : Number.NaN;
  });
  const start = tops.find(Number.isFinite) ?? 0;
  const spans = tops.map((top, index) => {
    const next = tops[index + 1] ?? end;
    return Number.isFinite(top) && Number.isFinite(next) ? Math.max(1, next - top) : 1;
  });
  const total = spans.reduce((sum, span) => sum + span, 0);
  return {
    end,
    start,
    weights: total > 0 ? spans.map((span) => span / total) : spans.map(() => 1 / (spans.length || 1)),
  };
};

/**
 * Track continuous reading position through a long guide, so a progress
 * indicator can move while the reader scrolls rather than only stepping at
 * heading boundaries.
 */
const useReadingProgress = (sections: readonly { id: string }[], active: boolean): ReadingProgress => {
  const [progress, setProgress] = useState<ReadingProgress>(EMPTY);

  useEffect(() => {
    if (!active || sections.length === 0) {
      setProgress(EMPTY);
      return undefined;
    }
    let frame = 0;
    // Re-measured on resize and after layout shifts (fonts, images) rather than
    // cached once: a guide's images land well after the first paint.
    let measured: Measurement = { end: 0, start: 0, weights: [] };

    const remeasure = () => {
      measured = measure(sections);
    };

    const read = () => {
      frame = 0;
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      // Only a document that can actually be scrolled has a scroll limit. One
      // that fits on a single screen is read from the top, so forcing it to the
      // last section there would report the end of a guide nobody has moved in.
      const atLimit = scrollable > 0 && window.scrollY >= scrollable - 2;
      let activeIndex = -1;
      sections.forEach(({ id }, index) => {
        const heading = document.getElementById(id);
        if (heading && heading.getBoundingClientRect().top <= HEADING_BAND_PX) activeIndex = index;
      });
      // The last section must be reachable even when the document ends before
      // its heading crosses the reading line.
      if (atLimit) activeIndex = sections.length - 1;
      // Measured from the same reading line that picks the active section, so
      // the weft reaches a tick boundary exactly when the heading does.
      const span = measured.end - measured.start;
      const travelled = window.scrollY + HEADING_BAND_PX - measured.start;
      setProgress({
        activeIndex: activeIndex < 0 ? 0 : activeIndex,
        fraction: atLimit ? 1 : clamp01(span > 0 ? travelled / span : 0),
        weights: measured.weights,
      });
    };

    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(read);
    };
    const relayout = () => {
      remeasure();
      schedule();
    };

    remeasure();
    read();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", relayout);
    document.fonts?.ready?.then(relayout).catch(() => undefined);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(relayout) : null;
    const article = document.querySelector(".docs-article");
    if (observer && article) observer.observe(article);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", relayout);
      observer?.disconnect();
    };
  }, [active, sections]);

  return progress;
};

export { useReadingProgress };
