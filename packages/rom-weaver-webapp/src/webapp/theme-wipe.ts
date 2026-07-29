import { createLogger } from "../lib/logging.ts";

/**
 * Circle-wipe fallback for engines where the View Transitions path is off
 * (iOS WebKit - see flat-transition.ts). No snapshots are available there, so
 * the wipe is painted by hand: a chassis-colored veil grows from the toggle to
 * cover the viewport, the theme flips underneath it, then the veil fades out to
 * reveal the repainted UI.
 */

const logger = createLogger("theme-wipe");

const GROW_MS = 380;
const FADE_MS = 220;
const EASE = "cubic-bezier(.4, 0, .2, 1)";

type WipeOrigin = { x: number; y: number; radius: number };

/** Radius that reaches the farthest viewport corner from the origin. */
const wipeOrigin = (rect: DOMRect | undefined): WipeOrigin => {
  const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
  const y = rect ? rect.top + rect.height / 2 : 0;
  return { x, y, radius: Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y)) };
};

/**
 * Chassis color the page will have once `theme` is applied. The attribute swap
 * is reverted in the same task, so no frame ever paints the wrong theme.
 */
const readChassis = (theme: string): string => {
  const root = document.documentElement;
  const previous = root.getAttribute("data-theme");
  root.setAttribute("data-theme", theme);
  const chassis = getComputedStyle(root).getPropertyValue("--chassis").trim();
  if (previous === null) root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", previous);
  return chassis;
};

const animationsUnavailable = () => typeof Element.prototype.animate !== "function";

/** Settle an in-flight wipe so a fast second tap starts from a clean state. */
let settleActiveWipe: (() => void) | null = null;

/**
 * Grow the veil, flip the theme, fade the veil. `applyTheme` runs exactly once
 * even if the animation is interrupted or unsupported.
 */
const runThemeWipeFallback = (origin: WipeOrigin, applyTheme: () => void) => {
  if (animationsUnavailable()) {
    logger.trace("theme wipe skipped: Web Animations unavailable");
    applyTheme();
    return;
  }
  settleActiveWipe?.();
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  const veil = document.createElement("div");
  veil.className = "theme-veil";
  veil.style.background = readChassis(next);
  veil.style.clipPath = `circle(0px at ${origin.x}px ${origin.y}px)`;
  document.body.append(veil);
  logger.trace("theme wipe started", { next, ...origin });

  let themeApplied = false;
  const applyOnce = () => {
    if (themeApplied) return;
    themeApplied = true;
    applyTheme();
  };
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    applyOnce();
    veil.remove();
    if (settleActiveWipe === finish) settleActiveWipe = null;
    logger.trace("theme wipe finished", { next });
  };
  settleActiveWipe = finish;

  const grow = veil.animate(
    [
      { clipPath: `circle(0px at ${origin.x}px ${origin.y}px)` },
      { clipPath: `circle(${origin.radius}px at ${origin.x}px ${origin.y}px)` },
    ],
    { duration: GROW_MS, easing: EASE, fill: "forwards" },
  );
  grow.onfinish = () => {
    applyOnce();
    // Repaint under the veil before it starts fading, otherwise the first fade
    // frames still show the outgoing theme through the thinning veil.
    requestAnimationFrame(() => {
      if (settled) return;
      const fade = veil.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: FADE_MS,
        easing: EASE,
        fill: "forwards",
      });
      fade.onfinish = finish;
      fade.oncancel = finish;
    });
  };
  grow.oncancel = finish;
};

export { runThemeWipeFallback, wipeOrigin };
