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
 * this module drains the buffer just before createRoot wipes the shell, then
 * re-issues each one against the mounted tree. Capture stops at that drain, so
 * a real post-mount click is never double-fired. Targets are re-found by id, or
 * by tag + role + accessible name, and anything that does not resolve to exactly
 * one mounted node is dropped - a wrong replay is far worse than a missed one.
 */

const logger = createLogger("shell-click-replay");

// A click older than this predates whatever the user is looking at now.
const MAX_REPLAY_AGE_MS = 3000;
const MAX_REPLAYED_CLICKS = 2;
// Accessible names are compared verbatim, so cap them rather than carry an
// entire pane's text content around.
const MAX_NAME_LENGTH = 120;

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

type ShellClickTarget = { id: string; name: string; role: string; tag: string };

type ShellClickBuffer = { clicks: { target: EventTarget | null; time: number }[]; stop: () => void };

let pending: ShellClickTarget[] = [];

const accessibleName = (element: Element) =>
  (element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH);

const isGestureGated = (element: Element) => {
  if (element.matches(GESTURE_GATED_SELECTOR) || element.querySelector(GESTURE_GATED_SELECTOR)) return true;
  const control = element instanceof HTMLLabelElement ? element.control : null;
  if (control instanceof HTMLInputElement && control.type === "file") return true;
  return !!element.closest(GESTURE_GATED_SELECTOR);
};

const isDisabled = (element: Element) =>
  element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true";

const describeClickTarget = (target: EventTarget | null): ShellClickTarget | null => {
  const element = target instanceof Element ? target.closest(INTERACTIVE_SELECTOR) : null;
  if (!element) return null;
  if (isGestureGated(element)) {
    logger.trace("Dropped a pre-mount click on a gesture-gated target", { tag: element.tagName });
    return null;
  }
  return {
    id: element.id,
    name: accessibleName(element),
    role: element.getAttribute("role") || "",
    tag: element.tagName,
  };
};

const isSameTarget = (element: Element, target: ShellClickTarget) =>
  element.tagName === target.tag &&
  (element.getAttribute("role") || "") === target.role &&
  accessibleName(element) === target.name;

const resolveTarget = (appRootElement: HTMLElement, target: ShellClickTarget): HTMLElement | null => {
  const candidates = Array.from(appRootElement.querySelectorAll(INTERACTIVE_SELECTOR)).filter(
    (element): element is HTMLElement =>
      element instanceof HTMLElement &&
      !isDisabled(element) &&
      !isGestureGated(element) &&
      (target.id ? element.id === target.id : isSameTarget(element, target)),
  );
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
};

/**
 * Drains the inline buffer into resolvable descriptors and stops capturing.
 * Call once, immediately before the first render replaces the shell.
 */
const captureShellClicks = () => {
  const buffer = (window as Window & { ROM_WEAVER_SHELL_CLICKS?: ShellClickBuffer }).ROM_WEAVER_SHELL_CLICKS;
  if (!buffer) return;
  buffer.stop();
  const now = Date.now();
  pending = buffer.clicks
    .filter((click) => now - click.time <= MAX_REPLAY_AGE_MS)
    .map((click) => describeClickTarget(click.target))
    .filter((target): target is ShellClickTarget => !!target)
    .slice(0, MAX_REPLAYED_CLICKS);
  buffer.clicks.length = 0;
  if (pending.length) logger.debug("Captured clicks that landed before the first mount", { count: pending.length });
};

/** Re-issues the captured clicks against the mounted tree. Call after the first render commits. */
const replayShellClicks = (appRootElement: HTMLElement) => {
  const targets = pending;
  pending = [];
  for (const target of targets) {
    const element = resolveTarget(appRootElement, target);
    if (!element) {
      logger.debug("Dropped a pre-mount click with no unique mounted target", target);
      continue;
    }
    logger.debug("Replaying a click that landed before the first mount", target);
    element.click();
  }
};

export { captureShellClicks, replayShellClicks };
