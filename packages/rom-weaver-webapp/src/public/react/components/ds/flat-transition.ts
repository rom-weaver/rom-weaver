import { createLogger } from "../../../../lib/logging.ts";

const logger = createLogger("flat-transition");

/**
 * Flat view-transition helper - the loom crossfade for layout changes with no
 * element continuity (tab switches). `vt-flat`
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

/** Engine-level check: no support, or the user asked for less motion. */
const viewTransitionsUnsupported = (): boolean => {
  if (typeof document.startViewTransition !== "function") return true;
  if (prefersReducedMotion()) {
    logger.trace("view transition skipped: prefers-reduced-motion");
    return true;
  }
  return false;
};

/**
 * iOS WebKit's view transitions are unreliable: the old/new snapshots flash
 * content in and out of existence mid-transition, and infinite animations
 * inside named elements (the hero formats ticker) freeze during capture and
 * never resume. Callers that name elements fall back to an instant update
 * there; the theme wipe suppresses every name (see `html.vt-theme` in
 * dialogs.css), so it uses `viewTransitionsUnsupported` and keeps the wipe.
 */
const viewTransitionsUnavailable = (): boolean => {
  if (viewTransitionsUnsupported()) return true;
  if (isIosWebKit()) {
    logger.trace("view transition skipped: iOS WebKit");
    return true;
  }
  return false;
};

/**
 * Refcounted `<html>` marker classes for in-flight transitions.
 *
 * Clicking again mid-transition starts a second run while the first is still
 * settling; the first's `finished` then resolves (as a skip) and its plain
 * `classList.remove` would strip the marker the live run depends on. The
 * survivor loses its wipe/flattening CSS and degrades into the default
 * per-element morph - the "theme switch lagged" symptom. Counting holders means
 * only the last release actually removes the class.
 */
const classHolds = new Map<string, number>();

const holdTransitionClasses = (classes: readonly string[]): (() => void) => {
  const root = document.documentElement;
  for (const name of classes) classHolds.set(name, (classHolds.get(name) ?? 0) + 1);
  root.classList.add(...classes);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const name of classes) {
      const held = (classHolds.get(name) ?? 1) - 1;
      if (held > 0) {
        classHolds.set(name, held);
        continue;
      }
      classHolds.delete(name);
      root.classList.remove(name);
    }
  };
};

/**
 * Run a synchronous DOM update inside a flat crossfade (no-op fallback).
 * `extraClass` tags the transition on `<html>` for the run's duration - mode
 * (tab) switches pass `vt-mode` so the CSS can flatten the per-form drop/head
 * names. The forms' names differ across tabs, so they would otherwise fade
 * independently and out of sync with the root crossfade.
 */
const runFlatViewTransition = (update: () => void, extraClass?: string) => {
  const classes = extraClass ? ["vt-flat", "vt-quiet", extraClass] : ["vt-flat", "vt-quiet"];
  if (viewTransitionsUnavailable()) {
    update();
    lockEntryAnimations();
    return;
  }
  const release = holdTransitionClasses(classes);
  const transition = document.startViewTransition(update);
  transition.ready.catch(() => undefined);
  const clear = () => {
    // lock first - removing vt-quiet would otherwise start the held animations
    lockEntryAnimations();
    release();
  };
  transition.finished.then(clear, clear);
};

export { holdTransitionClasses, prefersReducedMotion, runFlatViewTransition, viewTransitionsUnsupported };
