import { dispatchSelectionDelivery } from "../lib/input/selection-delivery.ts";
import {
  createFileDataTransfer,
  type DroppedFilesTransfer,
  readDataTransferFiles,
} from "../lib/input/dropped-files.ts";
import { createLogger } from "../lib/logging.ts";

/**
 * Buffer clicks on the prerendered shell until hydration attaches React handlers.
 * Click capture stops before hydration; file selections stay deferred until replay.
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

type ShellSelection = {
  files: File[];
  transfer?: DroppedFilesTransfer;
  kind: "drop" | "pick";
  target: EventTarget | null;
};
type ShellClickBuffer = {
  clicks: { target: EventTarget | null; time: number }[];
  selections?: ShellSelection[];
  deferSelections?: boolean;
  replaying?: boolean;
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
 * Retains buffered clicks and defers file selections before hydration attaches handlers.
 * Call once, immediately before hydration begins.
 */
const captureShellClicks = () => {
  const buffer = readShellBuffer();
  if (!buffer) return;
  buffer.stop();
  // File selections MUST stay ordered until replay drains them, including events during hydration.
  buffer.deferSelections = true;
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

const deliverPick = (appRootElement: HTMLElement, selection: ShellSelection, consumed: boolean) => {
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
  // The mounted tree's change handler already took this input's latest pick and reset the value.
  if (retained && consumed) return;
  input.files = createFileDataTransfer(selection.files).files;
  logger.debug("Delivering a file pick that landed before the first mount", { count: selection.files.length });
  return dispatchSelectionDelivery(input, new Event("change", { bubbles: true }));
};

const deliverDrop = (appRootElement: HTMLElement, selection: ShellSelection) => {
  const original = selection.target instanceof Element ? selection.target : null;
  const target = original && appRootElement.contains(original) ? original : appRootElement;
  logger.debug("Delivering a file drop that landed before the first mount", { count: selection.files.length });
  return dispatchSelectionDelivery(
    target,
    new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: createFileDataTransfer(selection.files),
    }),
  );
};

const discardShellSelections = () => {
  readShellBuffer()?.selections?.splice(0);
};

/**
 * Re-delivers buffered files in order after the first render commits.
 * Capture MUST stay active through the delayed frame and task so new selections cannot overtake replay.
 */
const replayShellSelections = (appRootElement: HTMLElement) => {
  const buffer = readShellBuffer();
  if (!buffer?.selections) return;
  const queue = buffer.selections;
  requestAnimationFrame(() => {
    setTimeout(() => {
      void (async () => {
        logger.debug("Captured file selections that landed before the first mount", { count: queue.length });
        // Only each input's latest pick is still on it; a reset input means React took that one.
        const lastPickByInput = new Map<EventTarget | null, ShellSelection>();
        for (const selection of queue) if (selection.kind === "pick") lastPickByInput.set(selection.target, selection);
        const consumedPicks = new Set<ShellSelection>();
        for (const [target, selection] of lastPickByInput) {
          if (target instanceof HTMLInputElement && target.files?.length === 0) consumedPicks.add(selection);
        }
        try {
          while (queue.length) {
            const selection = queue.shift();
            if (!selection) break;
            if (selection.kind === "drop" && selection.transfer) {
              try {
                selection.files = await readDataTransferFiles(selection.transfer);
              } catch (error) {
                logger.warn("Failed to read a buffered file drop", { error });
                continue;
              }
            }
            let delivery: Promise<void> | undefined;
            buffer.replaying = true;
            try {
              if (selection.kind === "pick")
                delivery = deliverPick(appRootElement, selection, consumedPicks.has(selection));
              else delivery = deliverDrop(appRootElement, selection);
            } finally {
              buffer.replaying = false;
            }
            await delivery;
          }
        } finally {
          buffer.stopSelections?.();
          buffer.deferSelections = false;
        }
      })();
    }, 0);
  });
};

export { captureShellClicks, discardShellSelections, replayShellClicks, replayShellSelections };
