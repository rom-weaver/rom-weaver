import { createLogger } from "../lib/logging.ts";

/**
 * Buffer clicks on the prerendered shell until hydration attaches React handlers.
 * Capture stops before hydration, and replay excludes actions that require trusted user activation.
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

// Replayed clicks have no trusted user activation, so omit file pickers, new windows, and downloads.
const GESTURE_GATED_SELECTOR = 'input[type="file"], a[download], a[target="_blank"]';

type ShellSelection = { files: File[]; kind: "drop" | "pick"; target: EventTarget | null };
type ShellClickBuffer = {
  clicks: { target: EventTarget | null; time: number }[];
  selections?: ShellSelection[];
  stop: () => void;
  stopSelections?: () => void;
};

const readShellBuffer = () =>
  (window as Window & { ROM_WEAVER_SHELL_CLICKS?: ShellClickBuffer }).ROM_WEAVER_SHELL_CLICKS;

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
  const buffer = readShellBuffer();
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

const toFileList = (files: File[]) => {
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  return transfer;
};

const deliverPick = (appRootElement: HTMLElement, selection: ShellSelection) => {
  const original = selection.target instanceof HTMLInputElement ? selection.target : null;
  if (!original) return;
  const retained = appRootElement.contains(original);
  const input = retained
    ? original
    : original.id
      ? appRootElement.querySelector<HTMLInputElement>(`input[type="file"]#${CSS.escape(original.id)}`)
      : null;
  if (!input || input.disabled) {
    logger.debug("Dropped a pre-mount file pick whose hydrated input is unavailable", { id: original.id });
    return;
  }
  if (retained) {
    // The mounted tree already consumed it: its change handler resets the value.
    if (input.files?.length === 0) return;
  } else {
    input.files = toFileList(selection.files).files;
  }
  logger.debug("Delivering a file pick that landed before the first mount", { count: selection.files.length });
  input.dispatchEvent(new Event("change", { bubbles: true }));
};

const deliverDrop = (appRootElement: HTMLElement, selection: ShellSelection) => {
  const original = selection.target instanceof Element ? selection.target : null;
  const target = original && appRootElement.contains(original) ? original : appRootElement;
  logger.debug("Delivering a file drop that landed before the first mount", { count: selection.files.length });
  target.dispatchEvent(
    new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: toFileList(selection.files),
    }),
  );
};

/**
 * Re-delivers files picked or dropped on the prerendered shell before the first mount.
 * Call after the first render commits; delivery waits one task so effect-installed
 * page handlers exist by the time a drop is dispatched.
 */
const replayShellSelections = (appRootElement: HTMLElement) => {
  const buffer = readShellBuffer();
  if (!buffer?.selections) return;
  buffer.stopSelections?.();
  const selections = buffer.selections.splice(0);
  if (!selections.length) return;
  logger.debug("Captured file selections that landed before the first mount", { count: selections.length });
  requestAnimationFrame(() => {
    setTimeout(() => {
      for (const selection of selections) {
        if (selection.kind === "pick") deliverPick(appRootElement, selection);
        else deliverDrop(appRootElement, selection);
      }
    }, 0);
  });
};

export { captureShellClicks, replayShellClicks, replayShellSelections };
