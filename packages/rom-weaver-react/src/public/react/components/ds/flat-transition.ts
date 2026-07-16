import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createLogger } from "../../../../lib/logging.ts";

const logger = createLogger("flat-transition");

/**
 * Flat view-transition helper - the loom crossfade for layout changes with no
 * element continuity (tab switches, the empty bench filling up). `vt-flat`
 * suppresses per-element morph names; `vt-quiet` holds entry animations while
 * the crossfade plays, and every entry-animatable element is locked inline
 * before the classes come off so re-shown content never replays its
 * entrance as a flicker.
 */

const ENTRY_ANIMATION_SELECTOR = ".workflow-body, .card:not(.pending-card), .notice, .result, .prog-panel, .fault";

const lockEntryAnimations = () => {
  for (const element of document.querySelectorAll<HTMLElement>(ENTRY_ANIMATION_SELECTOR)) {
    element.style.animation = "none";
  }
};

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* iOS/iPadOS WebKit only - no other engine implements -webkit-touch-callout. */
const isIosWebKit = () =>
  typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("-webkit-touch-callout", "none");

/**
 * iOS WebKit's view transitions are unreliable: the old/new snapshots flash
 * content in and out of existence mid-transition, and infinite animations
 * inside named elements (the hero formats ticker) freeze during capture and
 * never resume. Every caller falls back to an instant update there.
 */
const viewTransitionsUnavailable = (): boolean => {
  if (typeof document.startViewTransition !== "function") return true;
  if (prefersReducedMotion()) {
    logger.trace("view transition skipped: prefers-reduced-motion");
    return true;
  }
  if (isIosWebKit()) {
    logger.trace("view transition skipped: iOS WebKit");
    return true;
  }
  return false;
};

/**
 * Run a synchronous DOM update inside a flat crossfade (no-op fallback).
 * `extraClass` tags the transition on `<html>` for the run's duration - mode
 * (tab) switches pass `vt-mode` so the CSS can flatten the per-form drop/head
 * names: those names give the empty→filled morph its continuity WITHIN a form,
 * but across tabs the two forms' names differ, so they'd fade independently and
 * out of sync with the root crossfade instead of riding it as one surface.
 */
const runFlatViewTransition = (update: () => void, extraClass?: string) => {
  const root = document.documentElement;
  const classes = extraClass ? ["vt-flat", "vt-quiet", extraClass] : ["vt-flat", "vt-quiet"];
  if (viewTransitionsUnavailable()) {
    update();
    lockEntryAnimations();
    return;
  }
  root.classList.add(...classes);
  const transition = document.startViewTransition(update);
  transition.ready.catch(() => undefined);
  const clear = () => {
    // lock first - removing vt-quiet would otherwise start the held animations
    lockEntryAnimations();
    root.classList.remove(...classes);
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

export { runFlatViewTransition, useFlatTransitionFlag, viewTransitionsUnavailable };
