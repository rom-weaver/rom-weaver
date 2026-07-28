import { createLogger } from "../lib/logging.ts";

/**
 * Click replay across the first mount.
 *
 * The prerendered landing shell paints long before the bundle executes, so it
 * looks fully interactive while carrying no React handlers at all - a click in
 * that window is swallowed with no error and no feedback. The shell is not made
 * inert to close the gap, because looking instantly ready is the entire point of
 * prerendering it.
 *
 * So a tiny inline script in index.html (the earliest hook there is - the bundle
 * is a module and only runs after the HTML is parsed) buffers those clicks, and
 * this module drains the buffer just before hydration, then re-issues each one
 * against the same DOM node once React's handlers are attached. Capture stops at
 * that drain, so a real post-mount click is never double-fired.
 */

const logger = createLogger("shell-click-replay");

// A click older than this predates whatever the user is looking at now.
const MAX_REPLAY_AGE_MS = 3000;
const MAX_REPLAYED_CLICKS = 2;

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "label",
  "select",
  "summary",
  "textarea",
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="switch"]',
  '[role="tab"]',
].join(", ");

// Transient activation cannot be handed over: a script-dispatched click is not
// user-activated, so every gesture-gated action would be blocked by the browser
// anyway. File pickers are the one that matters here - the hero drop zone is a
// <label> wrapping #rom-weaver-input-file-unified - alongside new windows and
// downloads. These keep the pre-fix behaviour: the click is simply dropped.
const GESTURE_GATED_SELECTOR = 'input[type="file"], a[download], a[target="_blank"]';

type ShellClickBuffer = { clicks: { target: EventTarget | null; time: number }[]; stop: () => void };

let pending: HTMLElement[] = [];

const isGestureGated = (element: Element) => {
  if (element.matches(GESTURE_GATED_SELECTOR) || element.querySelector(GESTURE_GATED_SELECTOR)) return true;
  const control = element instanceof HTMLLabelElement ? element.control : null;
  if (control instanceof HTMLInputElement && control.type === "file") return true;
  return !!element.closest(GESTURE_GATED_SELECTOR);
};

const isDisabled = (element: Element) =>
  element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true";

const interactiveTarget = (target: EventTarget | null): HTMLElement | null => {
  const element = target instanceof Element ? target.closest(INTERACTIVE_SELECTOR) : null;
  if (!(element instanceof HTMLElement)) return null;
  if (isGestureGated(element)) {
    logger.trace("Dropped a pre-mount click on a gesture-gated target", { tag: element.tagName });
    return null;
  }
  return element;
};

/**
 * Drains the inline buffer into retained shell nodes and stops capturing.
 * Call once, immediately before hydration begins.
 */
const captureShellClicks = () => {
  const buffer = (window as Window & { ROM_WEAVER_SHELL_CLICKS?: ShellClickBuffer }).ROM_WEAVER_SHELL_CLICKS;
  if (!buffer) return;
  buffer.stop();
  const now = Date.now();
  pending = buffer.clicks
    .filter((click) => now - click.time <= MAX_REPLAY_AGE_MS)
    .map((click) => interactiveTarget(click.target))
    .filter((target): target is HTMLElement => !!target)
    .slice(0, MAX_REPLAYED_CLICKS);
  buffer.clicks.length = 0;
  if (pending.length) logger.debug("Captured clicks that landed before the first mount", { count: pending.length });
};

/** Re-issues the captured clicks against the mounted tree. Call after the first render commits. */
const replayShellClicks = (appRootElement: HTMLElement) => {
  const targets = pending;
  pending = [];
  for (const element of targets) {
    const details = { id: element.id, tag: element.tagName };
    if (!(appRootElement.contains(element) && !isDisabled(element) && !isGestureGated(element))) {
      logger.debug("Dropped a pre-mount click whose hydrated target is unavailable", details);
      continue;
    }
    logger.debug("Replaying a click that landed before the first mount", details);
    element.click();
  }
};

export { captureShellClicks, replayShellClicks };
