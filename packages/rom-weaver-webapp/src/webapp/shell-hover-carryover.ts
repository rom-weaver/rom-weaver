import { createLogger } from "../lib/logging.ts";

/**
 * Hover carryover across the first mount.
 *
 * The prerendered landing shell is replaced (not hydrated) by React's first
 * render, and browsers only recompute `:hover` when the pointer next moves - a
 * fresh node created under a stationary cursor starts out unhovered. A user
 * whose pointer already rests on the hero drop zone therefore watches the bead
 * and the drop frame drop out of their armed look the instant the bundle
 * mounts, with nothing they did to explain it.
 *
 * So the real hover state is read off the shell just before it is replaced and
 * re-published as `data-shell-hover` on #webapp-root (React never touches that
 * element's attributes), which the dropzone styles pair with their `:hover`
 * rules. The attribute is dropped again on the first event that lets the
 * browser recompute hover for itself, handing the state back to the UA.
 */

const logger = createLogger("shell-hover-carryover");

const HERO_SELECTOR = ".drop.hero";
const HOVER_ATTRIBUTE = "data-shell-hover";
// Every event after which the browser has re-resolved the hovered element on
// its own, making the stand-in attribute stale.
const RELEASE_EVENTS = ["pointermove", "pointerdown", "pointercancel", "wheel", "scroll", "blur"] as const;

let heroHovered = false;

const supportsHover = () => typeof matchMedia === "function" && matchMedia("(hover: hover)").matches;

/** Records whether the shell's hero drop zone is hovered. Call before the mount replaces it. */
const captureShellHeroHover = (appRootElement: HTMLElement) => {
  heroHovered = supportsHover() && !!appRootElement.querySelector(`${HERO_SELECTOR}:hover`);
  logger.trace("Captured shell hero hover", { heroHovered });
};

/** Re-publishes the captured hover as an attribute the styles honor until the browser catches up. */
const restoreShellHeroHover = (appRootElement: HTMLElement) => {
  const restore = heroHovered;
  heroHovered = false;
  if (!(restore && appRootElement.querySelector(HERO_SELECTOR))) return;
  appRootElement.setAttribute(HOVER_ATTRIBUTE, "hero");
  const release = () => {
    appRootElement.removeAttribute(HOVER_ATTRIBUTE);
    for (const type of RELEASE_EVENTS) window.removeEventListener(type, release, true);
    logger.trace("Released shell hero hover to the browser");
  };
  for (const type of RELEASE_EVENTS) window.addEventListener(type, release, { capture: true, passive: true });
  logger.trace("Restored shell hero hover across the first mount");
};

export { captureShellHeroHover, restoreShellHeroHover };
