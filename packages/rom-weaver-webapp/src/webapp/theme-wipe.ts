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
/* Transitions stay off until the flipped page has painted; see dialogs.css. */
const SETTLE_CLASS = "theme-wipe-settle";
const SETTLE_TIMEOUT_MS = 200;
/* Live state the clone cannot inherit from cloneNode alone. */
const STATEFUL = "input, textarea, select, details, dialog, video, audio";

type WipeOrigin = { x: number; y: number; radius: number };

/** Radius that reaches the farthest viewport corner from the origin. */
const wipeOrigin = (rect: DOMRect | undefined): WipeOrigin => {
  const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
  const y = rect ? rect.top + rect.height / 2 : 0;
  return { x, y, radius: Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y)) };
};

type Pair = [live: Element, clone: Element];

/** Pair every cloned element with its original, before the tree is edited. */
const pairTrees = (live: Element, clone: Element, pairs: Pair[]) => {
  pairs.push([live, clone]);
  for (const [index, child] of [...live.children].entries()) {
    const twin = clone.children[index];
    if (twin) pairTrees(child, twin, pairs);
  }
};

/* `target`/`pseudoElement` live on KeyframeEffect, not the base AnimationEffect. */
const keyframeEffect = (animation: Animation): KeyframeEffect | null =>
  animation.effect instanceof KeyframeEffect ? animation.effect : null;

/** Key an animation by what it runs on, so a match is unambiguous. */
const animationKey = (animation: Animation): string => {
  const name = "animationName" in animation ? String(animation.animationName) : "";
  return `${keyframeEffect(animation)?.pseudoElement ?? ""}|${name}`;
};

/**
 * A marquee mid-stride restarts at frame 0 in the clone and a one-shot entry
 * animation that already finished replays - both read as motion the live page
 * is not making. Sharing `startTime` puts the clone on the same timeline
 * origin, so it keeps moving in step from here on.
 *
 * Walks the whole clone in one pass because animations on `::before`/`::after`
 * never show up in `element.getAnimations()`, only in a subtree query.
 */
const syncAnimations = (veil: Element, liveOf: Map<Element, Element>) => {
  const liveIndex = new Map<Element, Map<string, Animation[]>>();
  const indexFor = (live: Element) => {
    const cached = liveIndex.get(live);
    if (cached) return cached;
    const index = new Map<string, Animation[]>();
    for (const animation of live.getAnimations({ subtree: true })) {
      if (keyframeEffect(animation)?.target !== live) continue;
      const key = animationKey(animation);
      const queue = index.get(key);
      if (queue) queue.push(animation);
      else index.set(key, [animation]);
    }
    liveIndex.set(live, index);
    return index;
  };

  for (const twin of veil.getAnimations({ subtree: true })) {
    const target = keyframeEffect(twin)?.target;
    const live = target ? liveOf.get(target) : undefined;
    const source = live ? indexFor(live).get(animationKey(twin))?.shift() : undefined;
    if (!source) {
      // Nothing running live under that key: a one-shot that already played
      // out. Cancelling leaves the clone in the settled style the page shows,
      // instead of replaying the entrance inside the circle.
      twin.cancel();
      continue;
    }
    if (source.startTime !== null) twin.startTime = source.startTime;
    else if (source.currentTime !== null) twin.currentTime = source.currentTime;
  }
};

/**
 * cloneNode copies markup, not state: typed values, checkbox/select state,
 * scroll offsets and in-flight animations all reset. Must run with the clone
 * already in the document - a detached element has no scrollable box and no
 * running animations, so there would be nothing to sync onto.
 */
const syncLiveState = (veil: Element, pairs: Pair[]) => {
  const liveOf = new Map<Element, Element>();
  for (const [source, target] of pairs) {
    if (!target.isConnected) continue;
    liveOf.set(target, source);
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
  }
  syncAnimations(veil, liveOf);
};

/**
 * The clone is laid out inside a fixed, viewport-sized box, so it has to be
 * pulled up by the page scroll to sit on top of what it duplicates. Elements
 * that are themselves fixed stay viewport-anchored and must not be shifted -
 * `.theme-veil` deliberately avoids transform/filter so it never becomes their
 * containing block.
 */
const buildVeil = (theme: string, origin: WipeOrigin): { veil: HTMLElement; pairs: Pair[] } => {
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
  const pairs: Pair[] = [];
  for (const child of document.body.children) {
    if (child.classList.contains("theme-veil")) continue;
    const clone = child.cloneNode(true) as Element;
    // Pair before stripping, so removing nodes cannot shift the pairing.
    pairTrees(child, clone, pairs);
    // A cloned <script> re-runs on insertion; the clone is a picture, not an app.
    for (const script of clone.querySelectorAll("script")) script.remove();
    stage.append(clone);
  }
  veil.append(stage);
  return { veil, pairs };
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
  const { veil, pairs } = buildVeil(next, origin);
  document.body.append(veil);
  // Same task as the insertion, so the clone never paints unsynced.
  syncLiveState(veil, pairs);
  logger.trace("theme wipe started", { next, pairs: pairs.length, ...origin });

  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    if (settleActiveWipe === finish) settleActiveWipe = null;
    const root = document.documentElement;
    // Flip with transitions off, and keep the clone up until the page beneath
    // has painted the new theme - lifting the veil on the same frame uncovers
    // surfaces still showing the outgoing colours.
    root.classList.add(SETTLE_CLASS);
    applyTheme();
    let lifted = false;
    const lift = () => {
      if (lifted) return;
      lifted = true;
      veil.remove();
      root.classList.remove(SETTLE_CLASS);
      logger.trace("theme wipe finished", { next });
    };
    requestAnimationFrame(() => requestAnimationFrame(lift));
    // rAF stalls in a backgrounded tab; never strand the clone on screen.
    setTimeout(lift, SETTLE_TIMEOUT_MS);
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
