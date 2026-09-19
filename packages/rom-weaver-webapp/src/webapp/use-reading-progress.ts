import { useEffect, useLayoutEffect, useState } from "react";

// Measure before the first client paint. The server still renders the stable
// empty state, while a reload avoids animating the active section marker in
// from the wrong state after hydration.
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

type ReadingProgress = {
  /** Index of the section being read, or -1 before the first heading. */
  activeIndex: number;
  /** True until the first client measurement has settled. */
  initializing: boolean;
};

/** Reading line: a heading counts as current once it passes under the masthead. */
const HEADING_BAND_PX = 108;

const EMPTY: ReadingProgress = { activeIndex: -1, initializing: true };

/**
 * Track the section that the reader has reached in a long guide.
 */
const useReadingProgress = (sections: readonly { id: string }[], active: boolean): ReadingProgress => {
  const [progress, setProgress] = useState<ReadingProgress>(EMPTY);
  const [initializing, setInitializing] = useState(true);

  useIsomorphicLayoutEffect(() => {
    if (!active || sections.length === 0) {
      setProgress(EMPTY);
      setInitializing(false);
      return undefined;
    }
    setInitializing(true);
    let frame = 0;
    let settleFrame = 0;
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
      setProgress({
        activeIndex: activeIndex < 0 ? 0 : activeIndex,
        initializing: true,
      });
    };

    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(read);
    };
    read();
    // Keep the first measured marker out of the transition until the browser
    // has painted the settled shell. Later scroll changes remain animated.
    settleFrame = requestAnimationFrame(() => setInitializing(false));
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      if (settleFrame) cancelAnimationFrame(settleFrame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [active, sections]);

  return { ...progress, initializing };
};

export { useReadingProgress };
