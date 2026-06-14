import { useEffect, useState } from "react";
import { flushSync } from "react-dom";

/**
 * Flat view-transition helper — the loom crossfade for layout changes with no
 * element continuity (tab switches, the empty bench filling up). `vt-flat`
 * suppresses per-element morph names; `vt-quiet` holds entry animations while
 * the crossfade plays, and every entry-animatable element is locked inline
 * before the classes come off so re-shown content never replays its
 * entrance as a flicker.
 */

const ENTRY_ANIMATION_SELECTOR = ".workflow-body, .card, .notice, .result, .prog-panel, .fault";

const lockEntryAnimations = () => {
  for (const element of document.querySelectorAll<HTMLElement>(ENTRY_ANIMATION_SELECTOR)) {
    element.style.animation = "none";
  }
};

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Run a synchronous DOM update inside a flat crossfade (no-op fallback). */
const runFlatViewTransition = (update: () => void) => {
  const root = document.documentElement;
  if (typeof document.startViewTransition !== "function" || prefersReducedMotion()) {
    update();
    lockEntryAnimations();
    return;
  }
  root.classList.add("vt-flat", "vt-quiet");
  const transition = document.startViewTransition(update);
  transition.ready.catch(() => undefined);
  const clear = () => {
    // lock first — removing vt-quiet would otherwise start the held animations
    lockEntryAnimations();
    root.classList.remove("vt-flat", "vt-quiet");
  };
  transition.finished.then(clear, clear);
};

/**
 * Defer a boolean layout flag by one flat crossfade: when `actual` flips, the
 * returned value follows inside a view transition, so the dependent layout
 * change (e.g. the 0x01 hero shrinking to the add-row) fades instead of
 * snapping.
 */
const useFlatTransitionFlag = (actual: boolean): boolean => {
  const [displayed, setDisplayed] = useState(actual);
  useEffect(() => {
    if (displayed === actual) return;
    runFlatViewTransition(() => {
      flushSync(() => setDisplayed(actual));
    });
  }, [actual, displayed]);
  return displayed;
};

export { runFlatViewTransition, useFlatTransitionFlag };
