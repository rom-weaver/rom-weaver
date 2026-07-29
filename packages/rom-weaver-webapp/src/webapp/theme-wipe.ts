import { createLogger } from "../lib/logging.ts";

/**
 * Circle-wipe fallback for engines where the View Transitions path is off
 * (iOS WebKit - see flat-transition.ts). No snapshots are available there, so
 * the wipe is painted by hand: a clone of the UI rendered in the *incoming*
 * theme is clip-revealed from the toggle over the live page, then the real
 * theme flips and the clone is dropped. The reveal shows real content, so
 * nothing blanks out mid-wipe.
 *
 * The clone is themed by `data-theme` on `.theme-veil`, which every
 * `:root[data-theme=...]` rule has a twin for (see tokens.css).
 */

const logger = createLogger("theme-wipe");

const WIPE_MS = 420;
const EASE = "cubic-bezier(.4, 0, .2, 1)";
/* Live state the clone cannot inherit from cloneNode alone. */
const STATEFUL = "input, textarea, select, details, dialog, video, audio";

type WipeOrigin = { x: number; y: number; radius: number };

/** Radius that reaches the farthest viewport corner from the origin. */
const wipeOrigin = (rect: DOMRect | undefined): WipeOrigin => {
  const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
  const y = rect ? rect.top + rect.height / 2 : 0;
  return { x, y, radius: Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y)) };
};

/**
 * cloneNode copies markup, not state: typed values, checkbox/select state,
 * scroll offsets and in-flight animations all reset. Walk both trees in step
 * and carry them over so the revealed clone matches the page it covers.
 */
const syncLiveState = (live: Element, clone: Element) => {
  const liveNodes = [live, ...live.querySelectorAll("*")];
  const cloneNodes = [clone, ...clone.querySelectorAll("*")];
  for (const [index, source] of liveNodes.entries()) {
    const target = cloneNodes[index];
    if (!target) break;
    if (source.scrollTop || source.scrollLeft) {
      target.scrollTop = source.scrollTop;
      target.scrollLeft = source.scrollLeft;
    }
    if (source.matches(STATEFUL)) {
      if (source instanceof HTMLInputElement && target instanceof HTMLInputElement) {
        target.value = source.value;
        target.checked = source.checked;
      } else if (source instanceof HTMLTextAreaElement && target instanceof HTMLTextAreaElement) {
        target.value = source.value;
      } else if (source instanceof HTMLSelectElement && target instanceof HTMLSelectElement) {
        target.selectedIndex = source.selectedIndex;
      } else if (source instanceof HTMLMediaElement && target instanceof HTMLMediaElement) {
        target.currentTime = source.currentTime;
      }
    }
    // Marquees and pulses would otherwise restart from frame 0 inside the
    // circle while the same element keeps running outside it.
    const running = source.getAnimations();
    if (running.length === 0) continue;
    const cloned = target.getAnimations();
    for (const [slot, animation] of running.entries()) {
      const twin = cloned[slot];
      if (twin && animation.currentTime !== null) twin.currentTime = animation.currentTime;
    }
  }
};

/**
 * The clone is laid out inside a fixed, viewport-sized box, so it has to be
 * pulled up by the page scroll to sit on top of what it duplicates. Elements
 * that are themselves fixed stay viewport-anchored and must not be shifted -
 * `.theme-veil` deliberately avoids transform/filter so it never becomes their
 * containing block.
 */
const buildVeil = (theme: string, origin: WipeOrigin): HTMLElement => {
  const veil = document.createElement("div");
  veil.className = "theme-veil";
  veil.setAttribute("aria-hidden", "true");
  veil.inert = true;
  for (const attribute of document.documentElement.attributes) {
    if (attribute.name !== "class") veil.setAttribute(attribute.name, attribute.value);
  }
  veil.setAttribute("data-theme", theme);
  veil.style.clipPath = `circle(0px at ${origin.x}px ${origin.y}px)`;

  const stage = document.createElement("div");
  stage.className = "theme-veil-stage";
  stage.style.insetBlockStart = `${-window.scrollY}px`;
  stage.style.insetInlineStart = `${-window.scrollX}px`;
  stage.style.width = `${document.documentElement.clientWidth}px`;
  for (const child of document.body.children) {
    if (child === veil || child.classList.contains("theme-veil")) continue;
    const clone = child.cloneNode(true) as Element;
    // Sync before stripping: the walk pairs the two trees by index.
    syncLiveState(child, clone);
    // A cloned <script> re-runs on insertion; the clone is a picture, not an app.
    for (const script of clone.querySelectorAll("script")) script.remove();
    stage.append(clone);
  }
  veil.append(stage);
  return veil;
};

const animationsUnavailable = () => typeof Element.prototype.animate !== "function";

/** Settle an in-flight wipe so a fast second tap starts from a clean state. */
let settleActiveWipe: (() => void) | null = null;

/**
 * Reveal the incoming theme from `origin`, then hand the page over to it.
 * `applyTheme` runs exactly once even if the wipe is interrupted.
 */
const runThemeWipeFallback = (origin: WipeOrigin, applyTheme: () => void) => {
  if (animationsUnavailable()) {
    logger.trace("theme wipe skipped: Web Animations unavailable");
    applyTheme();
    return;
  }
  settleActiveWipe?.();
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  const veil = buildVeil(next, origin);
  document.body.append(veil);
  logger.trace("theme wipe started", { next, ...origin });

  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    // Flip and drop the clone in one task: the page underneath already looks
    // like the clone, so no frame shows a mismatch.
    applyTheme();
    veil.remove();
    if (settleActiveWipe === finish) settleActiveWipe = null;
    logger.trace("theme wipe finished", { next });
  };
  settleActiveWipe = finish;

  const reveal = veil.animate(
    [
      { clipPath: `circle(0px at ${origin.x}px ${origin.y}px)` },
      { clipPath: `circle(${origin.radius}px at ${origin.x}px ${origin.y}px)` },
    ],
    { duration: WIPE_MS, easing: EASE, fill: "forwards" },
  );
  reveal.onfinish = finish;
  reveal.oncancel = finish;
};

export { runThemeWipeFallback, wipeOrigin };
