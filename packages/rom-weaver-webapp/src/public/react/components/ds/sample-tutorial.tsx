import {
  Archive,
  BookOpen,
  ChevronUp,
  Download,
  EllipsisVertical,
  FileDiff,
  Gamepad,
  ListChecks,
  ListOrdered,
  MousePointer2,
  Package,
  RefreshCw,
  Scissors,
  SlidersHorizontal,
  Stamp,
  ToggleRight,
  Upload,
  X,
} from "lucide-react";
import type { ComponentType, MouseEvent } from "react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createLogger } from "../../../../lib/logging.ts";
import {
  GUIDED_SAMPLE_START_EVENT,
  GUIDED_SAMPLE_VIEWS,
  GUIDED_SAMPLE_VIEW_EVENT,
  clearGuidedSampleQuery,
  readGuidedSampleFromSearch,
  type GuidedSample,
  requestOnboardingDismiss,
} from "../../guided-sample-start.ts";
import { useRomWeaverSettings, useUiLocalizer } from "../../settings-context.tsx";
import { SwapIcon } from "./swap-icon.tsx";

const startLogger = createLogger("sample-tutorial");

const isPlainLeftClick = (event: MouseEvent<HTMLAnchorElement>) =>
  event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;

type SampleTutorialAction =
  | "apply"
  | "archive"
  | "checks"
  | "create"
  | "download"
  | "drop"
  | "header"
  | "menu"
  | "options"
  | "package"
  | "play"
  | "remove"
  | "reorder"
  | "replace"
  | "swap"
  | "toggle";

const useGuidedSampleStart = (guide: GuidedSample, onStart: () => void, onDismiss: () => void, enabled = true) => {
  const onDismissRef = useRef(onDismiss);
  const onStartRef = useRef(onStart);
  onDismissRef.current = onDismiss;
  onStartRef.current = onStart;
  useEffect(() => {
    const ownerView = GUIDED_SAMPLE_VIEWS[guide];
    const startRequestedGuide = (event: Event) => {
      if (!enabled) return;
      if (!(event instanceof CustomEvent) || event.detail !== guide) return;
      onStartRef.current();
    };
    const dismissHiddenGuide = (event: Event) => {
      if (!enabled) return;
      if (!(event instanceof CustomEvent) || event.detail === ownerView) return;
      clearGuidedSampleQuery();
      onDismissRef.current();
    };
    window.addEventListener(GUIDED_SAMPLE_START_EVENT, startRequestedGuide);
    window.addEventListener(GUIDED_SAMPLE_VIEW_EVENT, dismissHiddenGuide);
    if (enabled && readGuidedSampleFromSearch(window.location.search) === guide) onStartRef.current();
    return () => {
      window.removeEventListener(GUIDED_SAMPLE_START_EVENT, startRequestedGuide);
      window.removeEventListener(GUIDED_SAMPLE_VIEW_EVENT, dismissHiddenGuide);
    };
  }, [enabled, guide]);
};

type SampleTutorialStep = {
  actions?: readonly (readonly [action: SampleTutorialAction, label: string])[];
  body: string;
  /** The step's own Continue work is under way - the practice files loading. */
  busy?: boolean;
  /** Selector, within the target, for the button this step asks you to press. */
  cta?: string;
  /** Document-level selector for a control that sits outside the target but
      belongs to the step - it is lifted clear of the scrim alongside it. */
  lift?: string;
  /** Continue waits while this is set: the step needs the reader to do
      something first, such as adding the files every later step looks at. */
  locked?: boolean;
  /** What Continue does on a locked step instead of waiting - loading the
      practice files, say. The guide moves on by itself once the step unlocks. */
  onContinue?: () => void;
  openDrawers?: boolean;
  openMenu?: boolean;
  /** `below` keeps the card under the row however tall the row is, for a row
      whose own controls - a drop zone's Add files button - the card must not
      cover. */
  placement?: "below" | "bottom" | "top";
  /** Document-level selector the step depends on. A step whose selector
      matches nothing when the guide opens is left out, so hosts without that
      control never count a step they cannot show. */
  requires?: string;
  target?: string;
  title: string;
  /** The one thing the reader should do on this step. */
  tryIt?: string;
  /** The Simple/Detailed step: its copy follows the live view setting, so the
      guide supplies the view sentence, Try it, and the comparison itself. A
      step with a body of its own keeps it ahead of the view sentence, and in
      hosts without the switch it stays as a plain step. */
  view?: boolean;
};

const VIEW_TOGGLE_SELECTOR = ".panel-view-toggle";
/** The switch's heading, not the switch: the heading is its own z-index layer,
    so a lift on the switch alone would stay under the scrim. */
const VIEW_TOGGLE_HEAD_SELECTOR = ".workflow-panel-head";

/**
 * The step that explains the Simple and Detailed views on the card it frames.
 * The panel heading's switch is lifted beside the card so flipping it shows the
 * card gain or lose its drawers. Embeds without the switch skip the step.
 *
 * Given a `base` step for the same card, the view explanation joins that step
 * instead of taking one of its own; without the switch, `base` is what remains.
 */
const getViewTutorialStep = (
  localizer: ReturnType<typeof useUiLocalizer>,
  target: string,
  base?: SampleTutorialStep,
): SampleTutorialStep =>
  base
    ? { ...base, lift: VIEW_TOGGLE_HEAD_SELECTOR, openDrawers: true, target, view: true }
    : {
        body: "",
        lift: VIEW_TOGGLE_HEAD_SELECTOR,
        openDrawers: true,
        requires: VIEW_TOGGLE_SELECTOR,
        target,
        title: localizer.message("ui.tutorial.view.title"),
        view: true,
      };

/**
 * The match for a step's selector that is actually on screen. Every visited
 * workflow panel stays mounted (hidden), and Apply and Bundle render the same
 * form, so a document-wide lookup can land on a hidden panel's copy of the row:
 * the ring would then frame an empty box and the row the reader sees would stay
 * under the scrim.
 */
const findShown = (selector: string) => {
  for (const match of document.querySelectorAll<HTMLElement>(selector)) {
    if (!match.closest("[hidden]")) return match;
  }
  return null;
};

/**
 * The lifted control that belongs to the target's own workbench. Every visited
 * workflow panel stays mounted (hidden), each with its own heading and switch,
 * so a document-wide lookup can land on a hidden panel's copy: the nearest
 * ancestor of the target that holds a match is the one the step means.
 */
const findLift = (target: HTMLElement, selector: string) => {
  for (let scope = target.parentElement; scope; scope = scope.parentElement) {
    const match = scope.querySelector<HTMLElement>(selector);
    if (match) return match;
  }
  return null;
};

/** Step numbers in the workbench's own 0x01 notation. */
const hexStep = (index: number) => `0x${(index + 1).toString(16).toUpperCase().padStart(2, "0")}`;

const ACTION_ICONS: Record<SampleTutorialAction, ComponentType<{ className?: string }>> = {
  apply: Stamp,
  archive: Archive,
  checks: ListChecks,
  create: FileDiff,
  download: Download,
  drop: Upload,
  header: Scissors,
  menu: EllipsisVertical,
  options: SlidersHorizontal,
  package: Package,
  play: Gamepad,
  remove: X,
  reorder: ListOrdered,
  replace: RefreshCw,
  swap: SwapIcon,
  toggle: ToggleRight,
};

const GUIDE_GAP = 14;
const GUIDE_MARGIN = 12;
/** The card leaves its old anchor before the step swaps, then arrives at the new one. */
const GUIDE_EXIT_MS = 130;
const GUIDE_ENTER_MS = 260;
const GUIDE_EXIT_EASE = "cubic-bezier(.4, 0, 1, 1)";
/** Matches the --ease token the rest of the guide's motion uses. */
const GUIDE_ENTER_EASE = "cubic-bezier(.2, .85, .3, 1)";
/** How far the card drifts toward its row as it arrives. */
const GUIDE_ENTER_RISE = 10;
/** Drawers expand over .3s, so the row keeps growing after a step opens. */
const GUIDE_SETTLE_MS = 360;
/** Caps the re-reveal so later layout shifts never yank the page around. */
const GUIDE_REVEALS = 3;
/** Above this share of the viewport a row is anchored from its top edge. */
const GUIDE_TALL_ROW_RATIO = 0.45;
/** A reveal scroll that has not moved the page by now never will. */
const GUIDE_SCROLL_START_MS = 150;
/** How far the ring sits outside the row it frames. */
const GUIDE_RING_INSET = 7;

type GuideRect = { bottom: number; height: number; left: number; top: number; width: number };

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Starts a guide-card animation with the cancel rejection already absorbed.
 * Cancelling an animation rejects its `finished` promise with an `AbortError`,
 * and every animation here is cancellable by the next move, so callers MUST go
 * through this helper: an unobserved rejection surfaces as an unhandled promise
 * rejection. Callers that need the settled result attach their own handler on
 * top of this one.
 */
const startGuideMotion = (
  element: Element,
  keyframes: PropertyIndexedKeyframes,
  options: KeyframeAnimationOptions,
): Animation => {
  const animation = element.animate(keyframes, options);
  animation.finished.catch(() => undefined);
  return animation;
};

const TutorialInputDemo = () => {
  const demoRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    let animations: Animation[] = [];
    const stop = () => {
      for (const animation of animations) animation.cancel();
    };
    const play = () => {
      stop();
      animations = [];
      if (media.matches) return;
      const cursor = demoRef.current?.querySelector(".demo-cursor");
      const file = demoRef.current?.querySelector(".demo-file");
      if (!(cursor && file && typeof cursor.animate === "function")) return;
      const options = { duration: 2800, easing: GUIDE_ENTER_EASE, iterations: 3 };
      animations = [
        startGuideMotion(
          cursor,
          {
            offset: [0, 0.3, 0.45, 0.6, 1],
            transform: [
              "translate(24px, 18px)",
              "translate(0, 0)",
              "translate(0, 3px)",
              "translate(0, 0)",
              "translate(24px, 18px)",
            ],
          },
          options,
        ),
        startGuideMotion(
          file,
          {
            offset: [0, 0.15, 0.25, 0.6, 0.75, 1],
            opacity: [0, 0, 1, 1, 0, 0],
            transform: [
              "translate(0, -28px)",
              "translate(0, -28px)",
              "translate(0, 0)",
              "translate(31px, 0)",
              "translate(31px, 10px)",
              "translate(0, -28px)",
            ],
          },
          options,
        ),
      ];
    };
    play();
    media.addEventListener("change", play);
    return () => {
      stop();
      media.removeEventListener("change", play);
    };
  }, []);
  return (
    <svg aria-hidden="true" className="sample-tutorial-input-demo" ref={demoRef} viewBox="0 0 400 44">
      <rect
        fill="var(--well)"
        height="42"
        rx="3"
        stroke="var(--seam-strong)"
        strokeDasharray="4 3"
        width="190"
        x="1"
        y="1"
      />
      <rect
        fill="var(--well)"
        height="42"
        rx="3"
        stroke="var(--seam-strong)"
        strokeDasharray="4 3"
        width="190"
        x="209"
        y="1"
      />
      <Upload height="22" width="22" x="84" y="11" />
      <g className="demo-cursor">
        <MousePointer2 height="22" width="22" x="96" y="18" />
      </g>
      <Archive height="22" width="22" x="293" y="11" />
      <g className="demo-file">
        <Gamepad height="22" width="22" x="262" y="11" />
      </g>
    </svg>
  );
};

const bindFinalCta = (cta: HTMLElement | null, final: boolean, onEnd: () => void) => {
  if (!(cta && final)) return null;
  cta.addEventListener("click", onEnd);
  return () => cta.removeEventListener("click", onEnd);
};

/** The same row, seen from the viewport a pending reveal scroll is about to land on. */
const shiftRect = (rect: GuideRect, by: number): GuideRect => ({
  bottom: rect.bottom - by,
  height: rect.height,
  left: rect.left,
  top: rect.top - by,
  width: rect.width,
});

/**
 * The row's own ancestors are `overflow: clip`, so an outline drawn on the row
 * gets cut off. The ring is rendered in the guide's portal instead and simply
 * frames the row's box.
 */
const ringAroundTarget = (rect: GuideRect) => ({
  height: rect.height + GUIDE_RING_INSET * 2,
  left: rect.left - GUIDE_RING_INSET,
  top: rect.top - GUIDE_RING_INSET,
  width: rect.width + GUIDE_RING_INSET * 2,
});
/** Desktop anchor breakpoint; explicit below placement and tall phone cards also anchor. */
const GUIDE_ANCHOR_QUERY = "(min-width: 641px)";

const clampWithin = (value: number, limit: number) =>
  Math.min(Math.max(value, GUIDE_MARGIN), Math.max(GUIDE_MARGIN, limit));

const clampBetween = (value: number, floor: number, limit: number) =>
  Math.min(Math.max(value, floor), Math.max(floor, limit));

/**
 * The top chrome the guide card must stay clear of, by the selector of every
 * layout that owns that band. The card only anchors on desktop, where the top
 * bar spans its column; the identity block is listed for the phone header and
 * for a route that renders one without the other. Each entry MUST name an
 * element in normal flow, so a limit measured here drops away once the chrome
 * scrolls off.
 */
const GUIDE_TOP_CHROME = [".rw-app .topbar", ".rw-app .shell-head"];

/**
 * The highest the card may sit. A bare margin from the viewport top is not it:
 * the top bar owns that band, and a card tall enough to be clamped there lands
 * on the theme and project controls - covering controls the reader can still
 * see and reach for. Measured rather than assumed, so it costs nothing once the
 * chrome has scrolled away and follows it through every width it changes at.
 */
const guideTopLimit = () =>
  GUIDE_TOP_CHROME.reduce((limit, selector) => {
    const rect = document.querySelector(selector)?.getBoundingClientRect();
    // A `display: contents` or hidden layout reports an empty box; it owns no
    // band and must not push the card down.
    if (!rect?.height) return limit;
    return Math.max(limit, rect.bottom + GUIDE_MARGIN);
  }, GUIDE_MARGIN);

/**
 * Which side of the row the card sits on. A row taller than a chunk of the
 * viewport anchors from its top, so the card lands beside the header the step
 * is describing instead of hundreds of pixels below it - and when the pair
 * cannot fit at all, keeping the row's top on screen matters more than its tail.
 * `below` pins the card under the row whatever its height: a step whose lifted
 * control sits above the row would otherwise get the card dropped onto that
 * control - the one the step asks the reader to use - once the row grows.
 */
type GuideSide = "below" | "bottom" | "top";
const shouldPlaceAbove = (rowHeight: number, prefer: GuideSide) =>
  prefer === "top" || (prefer === "bottom" && rowHeight > window.innerHeight * GUIDE_TALL_ROW_RATIO);

/**
 * Places the guide card against the row it describes, horizontally centred on
 * it and always kept inside the viewport.
 */
const anchorToTarget = (rect: GuideRect, dialog: HTMLElement, prefer: GuideSide) => {
  const { height, width } = dialog.getBoundingClientRect();
  const above = rect.top - GUIDE_GAP - height;
  const below = rect.bottom + GUIDE_GAP;
  const fitsAbove = above >= GUIDE_MARGIN;
  const fitsBelow = below + height <= window.innerHeight - GUIDE_MARGIN;
  // The reveal scroll parks the row so the preferred side fits, but the user
  // can scroll it anywhere afterwards - take the other side rather than clamp
  // the card back over the row.
  const preferred = shouldPlaceAbove(rect.height, prefer);
  const placeAbove = prefer !== "below" && (preferred ? fitsAbove || !fitsBelow : !(fitsBelow || !fitsAbove));
  const top = placeAbove ? above : below;
  return {
    left: clampWithin(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - GUIDE_MARGIN),
    top: clampBetween(top, guideTopLimit(), window.innerHeight - height - GUIDE_MARGIN),
  };
};

/**
 * How far to scroll so the row and its card sit together, centred as a pair
 * when the viewport can hold them. A row too tall to fit alongside the card
 * gives up its bottom edge rather than its top. `rect` is what has to stay in
 * view - the row plus any control lifted with it - while the side the card
 * takes is still decided by the row alone, as the anchoring does.
 */
const scrollDeltaForPair = (rect: GuideRect, dialog: HTMLElement | null, placeAbove: boolean) => {
  const cardHeight = dialog?.getBoundingClientRect().height ?? 0;
  const pair = rect.height + GUIDE_GAP + cardHeight;
  const slack = Math.max(GUIDE_MARGIN, (window.innerHeight - pair) / 2);
  const desiredTop = placeAbove ? slack + cardHeight + GUIDE_GAP : slack;
  return rect.top - desiredTop;
};

/**
 * How far to scroll on a phone, where the card is pinned to a screen edge rather
 * than beside the row: the row is centred in the band the card and the dock
 * leave free, or parked at that band's top when it is taller than the band.
 * Returns 0 when the row already sits inside the band, so a step whose row is
 * on screen never moves the page.
 */
const scrollDeltaForPinned = (rect: GuideRect, dialog: HTMLElement) => {
  const card = dialog.getBoundingClientRect();
  // `.dock-pad` is the in-flow spacer that carries the dock's height.
  const dock = document.querySelector(".rw-app .dock-pad")?.getBoundingClientRect().height ?? 0;
  const pinnedTop = card.top + card.height / 2 < window.innerHeight / 2;
  const bandTop = pinnedTop ? card.bottom + GUIDE_GAP : GUIDE_MARGIN;
  const bandBottom = pinnedTop ? window.innerHeight - dock - GUIDE_MARGIN : card.top - GUIDE_GAP;
  const room = bandBottom - bandTop;
  if (rect.height <= room && rect.top >= bandTop && rect.bottom <= bandBottom) return 0;
  const desiredTop = rect.height <= room ? bandTop + (room - rect.height) / 2 : bandTop;
  return rect.top - desiredTop;
};

/**
 * Whether the row and its anchored card are already fully on screen, below the
 * top chrome - then the reveal leaves the page where the reader has it.
 */
const pairInView = (rect: GuideRect, dialog: HTMLElement, placeAbove: boolean) => {
  const cardHeight = dialog.getBoundingClientRect().height;
  const top = placeAbove ? rect.top - GUIDE_GAP - cardHeight : rect.top;
  const bottom = placeAbove ? rect.bottom : rect.bottom + GUIDE_GAP + cardHeight;
  return top >= guideTopLimit() && bottom <= window.innerHeight - GUIDE_MARGIN;
};

/** The row and the control lifted with it, as one box to keep on screen. */
const unionRect = (rect: GuideRect, other: GuideRect | undefined): GuideRect => {
  // A hidden or `display: contents` lift reports an empty box and adds nothing.
  if (!other?.height) return rect;
  const top = Math.min(rect.top, other.top);
  const bottom = Math.max(rect.bottom, other.bottom);
  const left = Math.min(rect.left, other.left);
  const width = Math.max(rect.left + rect.width, other.left + other.width) - left;
  return { bottom, height: bottom - top, left, top, width };
};

const SampleTutorialStart = ({
  chipLabel,
  documentation,
  downloadHref,
  downloadLabel,
  downloadName,
  error,
  guideHref,
  label,
  loading,
  onStart,
  secondaryLabel,
  onSecondaryStart,
  secondaryHref,
  startAction = "apply",
  secondaryAction = "package",
}: {
  /** The page's own call to action on the closed chip ("Patch a sample"). */
  chipLabel: string;
  documentation?: { href: string; label: string };
  downloadHref: string;
  downloadLabel: string;
  downloadName: string;
  error: string;
  guideHref: string;
  label: string;
  loading: boolean;
  onStart: () => void;
  secondaryLabel?: string;
  onSecondaryStart?: () => void;
  secondaryHref?: string;
  /** Icons for the guided actions, keyed into the tutorial's action icon set. */
  startAction?: SampleTutorialAction;
  secondaryAction?: SampleTutorialAction;
}) => {
  const localizer = useUiLocalizer();
  const StartIcon = ACTION_ICONS[startAction];
  const SecondaryIcon = ACTION_ICONS[secondaryAction];
  const popId = useId();
  const chipRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // Dismissal also hides the beacon immediately (and for the whole session in
  // embeds where no shell listens for the persistence event).
  const [dismissed, setDismissed] = useState(false);
  const settings = useRomWeaverSettings() as { onboardingEnabled?: unknown };
  // The resolved href depends on where the app is served, which the prerender
  // cannot know. Render the root-relative form the server emits, then upgrade
  // after hydration so a sub-path deployment still links correctly.
  const [href, setHref] = useState(`/${downloadName}`);
  useEffect(() => setHref(downloadHref), [downloadHref]);
  useEffect(() => {
    if (error) setOpen(true);
  }, [error]);

  // Re-enabling the setting revives a locally dismissed beacon: in the webapp
  // a dismissal flips onboardingEnabled off, so the transition back to true is
  // exactly the Settings checkbox being saved. Hosts that pass a static value
  // (or none) never fire this, and there the local flag rules the session.
  useEffect(() => {
    if (settings.onboardingEnabled === true) setDismissed(false);
  }, [settings.onboardingEnabled]);

  useEffect(() => {
    if (!open) return;
    const closeFromOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      setOpen(false);
      chipRef.current?.focus();
    };
    window.addEventListener("pointerdown", closeFromOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeFromOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  if (settings.onboardingEnabled === false || dismissed) return null;
  return (
    <div className="first-weave-demo sample-tutorial-start" ref={rootRef}>
      <button
        aria-controls={popId}
        aria-expanded={open}
        className="sample-tutorial-start-chip"
        onClick={() => {
          startLogger.trace("tutorial help toggled", { open: !open });
          setOpen((current) => !current);
        }}
        ref={chipRef}
        type="button"
      >
        <span aria-hidden="true" className="sample-tutorial-start-knot" />
        {chipLabel}
        <ChevronUp aria-hidden="true" className="sample-tutorial-start-caret" />
      </button>
      {/* Mounted only while open: the closed popover would otherwise ship in
          the prerendered shell - four inline SVGs and all - on every page. */}
      {open ? (
        <div className="sample-tutorial-start-pop" id={popId}>
          <span aria-hidden="true" className="sample-tutorial-start-head mono">
            {localizer.message("ui.tutorial.start")}
          </span>
          <a
            aria-busy={loading}
            aria-disabled={loading || undefined}
            className="sample-tutorial-start-action sample-tutorial-start-primary"
            href={guideHref}
            onClick={(event) => {
              if (!isPlainLeftClick(event)) return;
              event.preventDefault();
              if (!loading) {
                setOpen(false);
                onStart();
              }
            }}
          >
            <span aria-hidden="true" className="sample-tutorial-start-action-icon">
              <StartIcon />
            </span>
            {loading ? localizer.message("ui.tutorial.loading") : label}
          </a>
          {secondaryLabel && onSecondaryStart && secondaryHref ? (
            <a
              aria-busy={loading}
              aria-disabled={loading || undefined}
              className="sample-tutorial-start-action sample-tutorial-start-secondary"
              href={secondaryHref}
              onClick={(event) => {
                if (!isPlainLeftClick(event)) return;
                event.preventDefault();
                if (!loading) {
                  setOpen(false);
                  onSecondaryStart();
                }
              }}
            >
              <span aria-hidden="true" className="sample-tutorial-start-action-icon">
                <SecondaryIcon />
              </span>
              {loading ? localizer.message("ui.tutorial.loading") : secondaryLabel}
            </a>
          ) : null}
          {documentation ? (
            <a className="sample-tutorial-start-action sample-tutorial-start-guide" href={documentation.href}>
              <BookOpen aria-hidden="true" />
              {documentation.label}
            </a>
          ) : null}
          <a className="sample-tutorial-start-action sample-tutorial-start-download" download href={href}>
            <Download aria-hidden="true" />
            {downloadLabel}
          </a>
          {error ? <span role="status">{error}</span> : null}
          <button
            className="sample-tutorial-start-action sample-tutorial-start-dismiss"
            onClick={() => {
              startLogger.debug("onboarding beacon dismissed");
              setOpen(false);
              setDismissed(true);
              requestOnboardingDismiss();
            }}
            type="button"
          >
            <X aria-hidden="true" />
            <span className="sample-tutorial-start-dismiss-copy">
              <span>{localizer.message("ui.tutorial.dismiss")}</span>
              <small>{localizer.message("ui.tutorial.reenable")}</small>
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
};

const SampleTutorial = ({
  download,
  error = "",
  loadingBody,
  onClose,
  ready,
  steps: allSteps,
}: {
  /** The guide's practice files, offered on its first step for readers who
      want their own copy - to add by hand, or to keep. */
  download?: { href: string; name: string };
  /** Why the practice files did not load; shown on the card. */
  error?: string;
  loadingBody: string;
  onClose: () => void;
  ready: boolean;
  steps: readonly SampleTutorialStep[];
}) => {
  const localizer = useUiLocalizer();
  const { detailedViewEnabled = false } = useRomWeaverSettings();
  const instructionsLabel = localizer.message("ui.tutorial.instructions");
  const actionsLabelId = useId();
  const bodyId = useId();
  const titleId = useId();
  // Decided once, when the guide opens: a control appearing or vanishing
  // mid-run must not renumber the steps under the reader. Measured after the
  // first commit, since the guide can mount in the same pass as the control,
  // and before paint, so a skipped step is never drawn.
  const [missingRequirements, setMissingRequirements] = useState<ReadonlySet<string>>(() => new Set());
  const initialStepsRef = useRef(allSteps);
  useLayoutEffect(() => {
    const selectors = initialStepsRef.current.flatMap((candidate) => [
      ...(candidate.requires ? [candidate.requires] : []),
      ...(candidate.view ? [VIEW_TOGGLE_SELECTOR] : []),
    ]);
    const missing = selectors.filter((selector) => !findShown(selector));
    if (missing.length) setMissingRequirements(new Set(missing));
  }, []);
  const steps = useMemo(
    () =>
      allSteps
        .filter((candidate) => !(candidate.requires && missingRequirements.has(candidate.requires)))
        .map((candidate) =>
          candidate.view && missingRequirements.has(VIEW_TOGGLE_SELECTOR)
            ? { ...candidate, lift: undefined, view: false }
            : candidate,
        ),
    [allSteps, missingRequirements],
  );
  const dialogRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const [stepIndex, setStepIndex] = useState(0);
  // The step whose Continue started its own work and is waiting to unlock.
  const [advanceFrom, setAdvanceFrom] = useState<number | null>(null);
  const [targetEl, setTargetEl] = useState<HTMLElement | null>(null);
  // Whether the guide is showing steps yet. Lags the `ready` prop by one exit
  // animation so the loading copy is gone before the card leaves the bottom bar.
  const [live, setLive] = useState(ready);
  // While moving, the card is parked invisible: it has left its old anchor and
  // the new one is not placed yet, so anything drawn there would be a flash.
  const [moving, setMoving] = useState(false);
  const motionRef = useRef<Animation | null>(null);
  const arrivingRef = useRef(false);
  const step = steps[stepIndex];
  const stepCta = step?.cta;
  const stepLift = step?.lift;
  const stepOpenDrawers = step?.openDrawers;
  const stepOpenMenu = step?.openMenu;
  const stepPlacement = step?.placement;
  const stepTarget = step?.target;
  const selectView = (detailed: boolean) => {
    if (!targetEl) return;
    const toggle = findLift(targetEl, VIEW_TOGGLE_SELECTOR)?.querySelector<HTMLInputElement>("input[type='checkbox']");
    if (toggle && !toggle.disabled && toggle.checked !== detailed) toggle.click();
  };
  const endGuide = () => {
    clearGuidedSampleQuery();
    onClose();
  };
  const endGuideRef = useRef(endGuide);
  endGuideRef.current = endGuide;
  // Resolved once: re-querying per render hands createPortal a different
  // container the moment .rw-app appears, which tears the whole overlay down
  // and rebuilds it - dropping focus and the live region instead of updating.
  const portalTarget = useMemo(
    () => (typeof document === "undefined" ? null : (document.querySelector(".rw-app") ?? document.body)),
    [],
  );

  // The guide is non-modal and lands last in the DOM, so nothing would reach it
  // without this - the button that opened it unmounts as soon as the sample
  // stages, dropping focus to <body>.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  /**
   * Hands the card from one anchor to the next: it fades out where it stands,
   * the caller's change lands while nothing is on screen, and the placement
   * effect fades it back in once the new anchor is written. Gliding across
   * instead only reads as motion when there is a previous anchor to leave -
   * the first step has none, so the card would jump the pinned bar's whole
   * height on the appearance the user sees first.
   */
  const beginMove = useCallback((commit: () => void) => {
    const dialog = dialogRef.current;
    if (!dialog || typeof dialog.animate !== "function" || prefersReducedMotion()) {
      commit();
      return;
    }
    motionRef.current?.cancel();
    setMoving(true);
    const exit = startGuideMotion(
      dialog,
      { opacity: [1, 0] },
      { duration: GUIDE_EXIT_MS, easing: GUIDE_EXIT_EASE, fill: "forwards" },
    );
    motionRef.current = exit;
    // The arriving flag MUST be raised with the commit, not with the exit: the
    // placement effect re-runs while the card is still leaving, and an early
    // flag lets it cancel this exit before it settles - which drops the commit
    // and strands the guide on the step it was leaving.
    // A cancelled exit rejects; the run that cancelled it owns the card now.
    exit.finished.then(
      () => {
        arrivingRef.current = true;
        commit();
      },
      () => undefined,
    );
  }, []);

  useEffect(() => {
    if (live === ready) return;
    beginMove(() => setLive(ready));
  }, [beginMove, live, ready]);

  useEffect(() => () => motionRef.current?.cancel(), []);

  // A Continue that started the step's own work - loading the practice files -
  // finishes the press once that work unlocks the step. A failed load leaves
  // the step where it is, with the reason on the card.
  const stepLocked = !!step?.locked;
  useEffect(() => {
    if (advanceFrom === null) return;
    if (advanceFrom !== stepIndex || error) {
      setAdvanceFrom(null);
      return;
    }
    if (!live || stepLocked) return;
    setAdvanceFrom(null);
    beginMove(() => setStepIndex((current) => Math.min(current + 1, steps.length - 1)));
  }, [advanceFrom, beginMove, error, live, stepIndex, stepLocked, steps.length]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Escape belongs to whatever the user is inside: menus, popovers, and the
      // inline reorder editor all own it, and the guide opens some of them
      // itself. Only claim it while the guide holds focus (or nothing does).
      const active = document.activeElement;
      const idle = !active || active === document.body;
      if (!(idle || dialogRef.current?.contains(active))) return;
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  useEffect(() => {
    const targetSelector = stepTarget;
    if (!(live && targetSelector)) return;
    let target: HTMLElement | null = null;
    let stage: HTMLElement | null = null;
    let previousDescription: string | null = null;
    let observer: MutationObserver | null = null;
    let openedMenu: HTMLButtonElement | null = null;
    let cta: HTMLElement | null = null;
    let removeCtaEndListener: (() => void) | null = null;
    let lifted: HTMLElement | null = null;
    const openedDrawers: HTMLButtonElement[] = [];
    let frame = 0;
    const connect = () => {
      if (target) return true;
      target = findShown(targetSelector);
      if (!target) return false;
      stage = target.closest<HTMLElement>(".step");
      setTargetEl(target);
      previousDescription = target.getAttribute("aria-describedby");
      target.classList.add("sample-tutorial-target");
      stage?.classList.add("sample-tutorial-stage");
      target.setAttribute("aria-describedby", [previousDescription, bodyId].filter(Boolean).join(" "));
      if (stepOpenDrawers) {
        for (const drawer of target.querySelectorAll<HTMLButtonElement>(".cks > .cks-head[aria-expanded='false']")) {
          openedDrawers.push(drawer);
          drawer.click();
        }
      }
      if (stepOpenMenu) {
        openedMenu = target.querySelector<HTMLButtonElement>(".patch-menu-btn[aria-expanded='false']");
        openedMenu?.click();
      }
      if (stepLift) {
        // The swap control lives between two rows, so no single target can hold
        // it. Lift its row, not the button: .swap-row sets a z-index of its own,
        // so a lift on the button would be scoped inside that stacking context.
        lifted = findLift(target, stepLift);
        lifted?.classList.add("sample-tutorial-lift");
      }
      if (stepCta) {
        // A data attribute, not a class: React rewrites this button's className
        // whenever its download state changes and would drop a class we added.
        cta = target.querySelector<HTMLElement>(stepCta);
        cta?.setAttribute("data-guide-cta", "true");
        removeCtaEndListener = bindFinalCta(cta, stepIndex === steps.length - 1, () => endGuideRef.current());
      }
      return true;
    };
    frame = window.requestAnimationFrame(() => {
      if (!connect()) {
        observer = new MutationObserver(() => {
          if (connect()) observer?.disconnect();
        });
        observer.observe(document.body, { childList: true, subtree: true });
      }
    });
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      setTargetEl(null);
      if (openedMenu?.getAttribute("aria-expanded") === "true") openedMenu.click();
      for (const drawer of openedDrawers) {
        if (drawer.getAttribute("aria-expanded") === "true") drawer.click();
      }
      removeCtaEndListener?.();
      cta?.removeAttribute("data-guide-cta");
      lifted?.classList.remove("sample-tutorial-lift");
      target?.classList.remove("sample-tutorial-target");
      stage?.classList.remove("sample-tutorial-stage");
      if (target) {
        if (previousDescription) target.setAttribute("aria-describedby", previousDescription);
        else target.removeAttribute("aria-describedby");
      }
    };
  }, [bodyId, live, stepCta, stepIndex, stepLift, stepOpenDrawers, stepOpenMenu, stepTarget, steps.length]);

  // Use document coordinates so the ring and anchored card scroll with the row.
  // Placement MUST NOT run on scroll: main-thread updates can lag composited scrolling.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const ring = ringRef.current;
    if (dialog && dialog.dataset.step !== (live ? String(stepIndex + 1) : undefined)) return;
    const unanchor = () => {
      if (!dialog) return;
      delete dialog.dataset.anchored;
      delete dialog.dataset.glide;
      dialog.style.left = "";
      dialog.style.top = "";
    };
    // Fades the card back in wherever the placement below just put it. A step
    // that anchors to a row waits for that placement; one without a row has
    // nothing to wait for and must not be left parked invisible.
    const arrive = () => {
      if (!(arrivingRef.current && dialog && typeof dialog.animate === "function")) return;
      arrivingRef.current = false;
      motionRef.current?.cancel();
      setMoving(false);
      // Drifts in from the row's side, so the card reads as coming off the row
      // it explains rather than materialising in place.
      const rise = stepPlacement === "top" ? -GUIDE_ENTER_RISE : GUIDE_ENTER_RISE;
      motionRef.current = startGuideMotion(
        dialog,
        { opacity: [0, 1], translate: [`0 ${rise}px`, "0 0"] },
        { duration: GUIDE_ENTER_MS, easing: GUIDE_ENTER_EASE },
      );
    };
    if (!(targetEl && dialog && ring)) {
      unanchor();
      if (!stepTarget) arrive();
      return;
    }
    // A control lifted above the row keeps the card below it, never over it.
    const liftedAbove = stepLift ? findLift(targetEl, stepLift)?.getBoundingClientRect() : undefined;
    const prefer: GuideSide =
      liftedAbove?.height && liftedAbove.bottom <= targetEl.getBoundingClientRect().top
        ? "below"
        : (stepPlacement ?? "bottom");
    const desktop = window.matchMedia(GUIDE_ANCHOR_QUERY);
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    let settle = 0;
    let scrollStart = 0;
    let revealsLeft = GUIDE_REVEALS;
    let rowHeight = targetEl.getBoundingClientRect().height;
    let cardHeight = dialog.getBoundingClientRect().height;
    // Where the running reveal scroll will land, while it runs. A placement made
    // mid-scroll - the card resizing as its new copy lands, say - MUST aim at
    // that viewport too: clamped to the one being scrolled away from, the card
    // rides off screen with it.
    let revealTo: number | null = null;
    const pendingShift = () => {
      if (revealTo === null) return 0;
      const left = revealTo - window.scrollY;
      if (Math.abs(left) < 1) revealTo = null;
      return revealTo === null ? 0 : left;
    };
    // A phone card placed below its target MUST ride the page to keep both reachable.
    const anchorCard = () =>
      desktop.matches || stepPlacement === "below" || dialog.getBoundingClientRect().height > window.innerHeight * 0.6;
    // Only when moving between steps - see the glide rules in dropzone.css.
    const setGlide = (element: HTMLElement, glide: boolean) => {
      if (glide) element.dataset.glide = "true";
      else delete element.dataset.glide;
    };
    /**
     * `shift` is the reveal scroll this placement is about to be followed by:
     * which side of the row the card takes, and the clamp that keeps it on
     * screen, are decided against the viewport that scroll lands on rather than
     * the one being left behind.
     */
    const place = (glide: boolean, shift = 0) => {
      const rect = targetEl.getBoundingClientRect();
      const card = anchorCard() ? anchorToTarget(shiftRect(rect, shift), dialog, prefer) : null;
      // Anchored phone cards MUST follow the row without covering its controls.
      if (card && !desktop.matches) card.top = rect.bottom - shift + GUIDE_GAP;
      const box = ringAroundTarget(rect);
      // Viewport to document. Every box is measured before anything is written,
      // so a placement never interleaves reads and writes into a forced reflow.
      const originX = window.scrollX;
      const originY = window.scrollY;
      setGlide(ring, glide);
      ring.style.height = `${box.height}px`;
      ring.style.left = `${box.left + originX}px`;
      ring.style.top = `${box.top + originY}px`;
      ring.style.width = `${box.width}px`;
      // Only the ring glides. The card is hidden between anchors and fades in
      // where it lands, so a transition here would slide it under its own
      // arrival - and on the first step there is no previous anchor to slide from.
      if (!card) {
        unanchor();
        return;
      }
      dialog.dataset.anchored = "true";
      dialog.style.left = `${card.left + originX}px`;
      // The card was placed in the post-shift viewport, which is `shift` further
      // down the document than the current one.
      dialog.style.top = `${card.top + originY + shift}px`;
    };
    // Park the row and its card together, and place them for where that scroll
    // is headed - once placed they ride the page, so this is the only chance.
    // The guide does the scrolling: the reader never has to go looking for the
    // row a step describes.
    const placeAndReveal = (glide: boolean) => {
      const rect = targetEl.getBoundingClientRect();
      // The lifted control is part of the step - the view step's switch sits in
      // the panel heading above the row - so the reveal keeps it in view too.
      const lifted = stepLift ? findLift(targetEl, stepLift)?.getBoundingClientRect() : undefined;
      const reveal = unionRect(rect, lifted);
      const placeAbove = desktop.matches && shouldPlaceAbove(rect.height, prefer);
      let top = 0;
      if (!anchorCard()) top = scrollDeltaForPinned(reveal, dialog);
      else if (!pairInView(reveal, dialog, placeAbove)) {
        top = scrollDeltaForPair(reveal, dialog, placeAbove);
        // When the lifted control, the row and the card cannot all fit, the
        // card below gets as much room as scrolling can give it without
        // pushing the lifted control - the one the step asks the reader to
        // use - or the row's top off the screen. Whatever is still short is
        // the card overlapping the row's tail, never the control.
        if (!placeAbove) {
          const floor = window.innerHeight - GUIDE_MARGIN;
          const cardBottom = rect.bottom + GUIDE_GAP + dialog.getBoundingClientRect().height;
          top = Math.max(top, Math.min(cardBottom - floor, reveal.top - guideTopLimit()));
        }
      }
      // The page cannot scroll past either end, and a card placed for a scroll
      // that falls short would miss its row by the difference. A page that
      // reports no scrollable height is left to the start check below.
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      const reachable = maxScroll > 0 ? Math.min(Math.max(top, -window.scrollY), maxScroll - window.scrollY) : top;
      const shift = Math.abs(reachable) > 1 ? reachable : 0;
      const from = window.scrollY;
      revealTo = shift ? from + shift : null;
      place(glide, shift);
      if (!shift) return;
      window.scrollBy({ behavior, top: shift });
      // Placed for a viewport the page never reaches, the card would sit off
      // its row: a scroll that has not started gets the card re-placed where
      // the page actually is.
      window.clearTimeout(scrollStart);
      scrollStart = window.setTimeout(() => {
        if (revealTo === null || Math.abs(window.scrollY - from) >= 1) return;
        revealTo = null;
        place(false);
      }, GUIDE_SCROLL_START_MS);
    };
    const track = () => place(false);
    // A re-reveal that lands while the user is scrolling fights them for the
    // scroll position, and the page - ring and all - shakes until one of the
    // two wins. Deliberate scroll input retires the rest of this step's
    // re-reveals; the opening one has already run by then.
    const yieldToUser = () => {
      revealsLeft = 0;
      revealTo = null;
      window.clearTimeout(settle);
    };
    // The reveal has landed: settle the pair against the viewport it reached.
    const onScrollEnd = () => {
      if (revealTo === null) return;
      revealTo = null;
      place(false);
    };
    // The row grows as its drawers expand, so re-reveal once each size change
    // has stopped - otherwise the card ends up sitting over the row it explains.
    // On a phone the pinned card's own height sets the room the row gets, so a
    // card that grows with its new copy re-reveals too. Gated on those heights:
    // mobile browser chrome collapsing as the user scrolls must not scroll the
    // page out from under them.
    const onResize = () => {
      place(false, pendingShift());
      const height = targetEl.getBoundingClientRect().height;
      const card = dialog.getBoundingClientRect().height;
      const cardMoved = !anchorCard() && card !== cardHeight;
      cardHeight = card;
      if (height === rowHeight && !cardMoved) return;
      rowHeight = height;
      if (revealsLeft <= 0) return;
      window.clearTimeout(settle);
      settle = window.setTimeout(() => {
        revealsLeft -= 1;
        placeAndReveal(false);
      }, GUIDE_SETTLE_MS);
    };
    const observer = new ResizeObserver(onResize);
    placeAndReveal(true);
    arrive();
    observer.observe(targetEl);
    observer.observe(dialog);
    window.addEventListener("resize", track);
    window.addEventListener("wheel", yieldToUser, { passive: true });
    window.addEventListener("touchmove", yieldToUser, { passive: true });
    window.addEventListener("keydown", yieldToUser);
    window.addEventListener("scrollend", onScrollEnd);
    desktop.addEventListener("change", track);
    return () => {
      window.clearTimeout(settle);
      window.clearTimeout(scrollStart);
      observer.disconnect();
      window.removeEventListener("resize", track);
      window.removeEventListener("wheel", yieldToUser);
      window.removeEventListener("touchmove", yieldToUser);
      window.removeEventListener("keydown", yieldToUser);
      window.removeEventListener("scrollend", onScrollEnd);
      desktop.removeEventListener("change", track);
      // The card is deliberately left where it is: clearing it here would make
      // the next step's placement measure from the CSS-pinned bar and glide
      // across the screen instead of from the card the user is looking at.
    };
  }, [live, stepIndex, stepLift, stepPlacement, stepTarget, targetEl]);

  if (!(portalTarget && step)) return null;
  const finalStep = live && stepIndex === steps.length - 1;
  const copyKey = live ? stepIndex : "loading";
  const viewBody = localizer.message(
    detailedViewEnabled ? "ui.tutorial.view.detailedBody" : "ui.tutorial.view.simpleBody",
  );
  const stepBody = step.view ? [step.body, viewBody].filter(Boolean).join(" ") : step.body;
  const locked = live && !!step.locked;
  const busy = live && (!!step.busy || advanceFrom === stepIndex);
  const stepTryIt = step.view
    ? localizer.message(detailedViewEnabled ? "ui.tutorial.view.detailedTryIt" : "ui.tutorial.view.simpleTryIt")
    : step.tryIt;
  const currentLabel = localizer.message("ui.tutorial.view.current");
  const layer = (
    <div className="sample-tutorial-layer">
      <div aria-hidden="true" className="sample-tutorial-scrim" />
      {/* The placement effect owns coordinates and anchor flags so React renders
          do not overwrite the measured position. */}
      {targetEl ? <div aria-hidden="true" className="sample-tutorial-ring" ref={ringRef} /> : null}
      <div
        aria-busy={!live}
        aria-describedby={bodyId}
        aria-labelledby={titleId}
        aria-modal="false"
        className="sample-tutorial-dialog"
        data-loading={live ? undefined : "true"}
        data-moving={moving ? "true" : undefined}
        data-placement={live ? (step.placement ?? "bottom") : "bottom"}
        data-step={live ? stepIndex + 1 : undefined}
        data-step-count={live ? steps.length : undefined}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <button
          aria-label={localizer.message("ui.tutorial.exit")}
          className="sample-tutorial-exit"
          onClick={endGuide}
          type="button"
        >
          <X aria-hidden="true" />
        </button>
        <span aria-hidden="true" className="sample-tutorial-beacon">
          {live ? hexStep(stepIndex) : "0x"}
        </span>
        {/* The live region has to outlive the step copy: a region inserted
            together with its content is never announced, so only the copy
            inside it is keyed per step. */}
        <section aria-label={instructionsLabel} className="sample-tutorial-copy-area">
          <div aria-live="polite" className="sample-tutorial-live">
            <div className="sample-tutorial-copy" key={copyKey}>
              <div className="sample-tutorial-kicker-row">
                <span className="sample-tutorial-kicker mono">
                  {live
                    ? localizer.message("ui.tutorial.step", { step: stepIndex + 1, total: steps.length })
                    : localizer.message("ui.tutorial.preparing")}
                </span>
                {live ? (
                  <span aria-hidden="true" className="sample-tutorial-pips">
                    {steps.map((candidate, index) => (
                      <i
                        data-state={index < stepIndex ? "done" : index === stepIndex ? "current" : undefined}
                        key={candidate.title}
                      />
                    ))}
                  </span>
                ) : null}
              </div>
              <h2 id={titleId}>{live ? step.title : localizer.message("ui.tutorial.loadingTitle")}</h2>
              <p id={bodyId}>{live ? stepBody : loadingBody}</p>
              {live && step.view ? (
                <div className="sample-tutorial-compare">
                  <button
                    aria-label={localizer.message("ui.tutorial.view.simple")}
                    aria-pressed={!detailedViewEnabled}
                    data-current={detailedViewEnabled ? undefined : "true"}
                    onClick={() => selectView(false)}
                    type="button"
                  >
                    <strong>
                      {localizer.message("ui.tutorial.view.simple")}
                      {detailedViewEnabled ? null : <em className="mono">{currentLabel}</em>}
                    </strong>
                    <span>{localizer.message("ui.tutorial.view.simpleSummary")}</span>
                  </button>
                  <button
                    aria-label={localizer.message("ui.view.detailed")}
                    aria-pressed={detailedViewEnabled}
                    data-current={detailedViewEnabled ? "true" : undefined}
                    onClick={() => selectView(true)}
                    type="button"
                  >
                    <strong>
                      {localizer.message("ui.view.detailed")}
                      {detailedViewEnabled ? <em className="mono">{currentLabel}</em> : null}
                    </strong>
                    <span>{localizer.message("ui.tutorial.view.detailedSummary")}</span>
                  </button>
                </div>
              ) : null}
              {live && stepTryIt ? (
                <p className="sample-tutorial-try">
                  <b className="mono">{localizer.message("ui.tutorial.tryIt")}</b>
                  <span>{stepTryIt}</span>
                </p>
              ) : null}
              {live && stepIndex === 0 && download ? <TutorialInputDemo /> : null}
              {live && stepIndex === 0 && download ? (
                <p className="sample-tutorial-practice">
                  <span>{localizer.message("ui.tutorial.practiceFiles")}</span>
                  <a className="btn ghost slim" download={download.name} href={download.href}>
                    <Download aria-hidden="true" />
                    {localizer.message("ui.tutorial.downloadPractice", { file: download.name })}
                  </a>
                </p>
              ) : null}
              {error ? (
                <p className="sample-tutorial-error" role="status">
                  {error}
                </p>
              ) : null}
              {live ? null : (
                <div
                  aria-label={localizer.message("ui.tutorial.loadingProgress")}
                  aria-valuetext={localizer.message("ui.tutorial.preparingProgress")}
                  className="sample-tutorial-progress"
                  role="progressbar"
                >
                  <span />
                </div>
              )}
              {live && step.actions?.length ? (
                <span className="sample-tutorial-action-label mono" id={actionsLabelId}>
                  {localizer.message("ui.tutorial.actions")}
                </span>
              ) : null}
              {live && step.actions?.length ? (
                <ul aria-labelledby={actionsLabelId} className="sample-tutorial-action-list">
                  {step.actions.map(([action, label]) => {
                    const Icon = ACTION_ICONS[action];
                    return (
                      <li key={label}>
                        <span aria-hidden="true" className="sample-tutorial-action-icon">
                          <Icon />
                        </span>
                        {label}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </div>
          </div>
        </section>
        <div className="sample-tutorial-actions">
          {live ? (
            <button
              aria-disabled={moving || stepIndex === 0 ? "true" : undefined}
              className="btn ghost slim"
              onClick={() => {
                if (moving || stepIndex === 0) return;
                beginMove(() => setStepIndex((current) => current - 1));
              }}
              type="button"
            >
              {localizer.message("ui.tutorial.back")}
            </button>
          ) : null}
          {/* Sits between the buttons rather than on a line of its own, so it
              costs the card no height; phones drop it for the ✕ alone. */}
          {live ? <p className="sample-tutorial-end-hint">{localizer.message("ui.tutorial.endHint")}</p> : null}
          {live ? (
            <button
              aria-busy={busy || undefined}
              aria-disabled={busy || (locked && !step.onContinue) ? "true" : undefined}
              className="btn primary slim sample-tutorial-next"
              onClick={() => {
                // A second press mid-handoff would cancel the exit the first one
                // started, stranding the card invisible on a step it never left.
                if (moving || busy) return;
                if (locked) {
                  if (!step.onContinue) return;
                  setAdvanceFrom(stepIndex);
                  step.onContinue();
                  return;
                }
                if (finalStep) endGuide();
                else beginMove(() => setStepIndex((current) => current + 1));
              }}
              type="button"
            >
              {busy
                ? localizer.message("ui.tutorial.loading")
                : finalStep
                  ? localizer.message("ui.tutorial.done")
                  : localizer.message("ui.tutorial.continue")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
  return createPortal(layer, portalTarget);
};

export { getViewTutorialStep, SampleTutorial, SampleTutorialStart, type SampleTutorialStep, useGuidedSampleStart };
