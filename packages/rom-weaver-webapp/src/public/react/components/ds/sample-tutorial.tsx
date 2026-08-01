import {
  Archive,
  Download,
  EllipsisVertical,
  GitCompare,
  ListChecks,
  ListOrdered,
  Package,
  Scissors,
  SlidersHorizontal,
  ToggleRight,
  Upload,
  X,
} from "lucide-preact";
import type { ComponentType, JSX, TargetedMouseEvent } from "preact";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import { createLogger } from "../../../../lib/logging.ts";
import { ApplyBandaidIcon } from "../apply-bandaid-icon.tsx";
import {
  GUIDED_SAMPLE_START_EVENT,
  GUIDED_SAMPLE_VIEW_EVENT,
  clearGuidedSampleQuery,
  type GuidedSample,
  requestOnboardingDismiss,
} from "../../guided-sample-start.ts";
import { useRomWeaverSettings } from "../../settings-context.tsx";
import { SwapIcon } from "./swap-icon.tsx";

const startLogger = createLogger("sample-tutorial");

const isPlainLeftClick = (event: TargetedMouseEvent<HTMLAnchorElement>) =>
  event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;

type SampleTutorialAction =
  | "apply"
  | "archive"
  | "checks"
  | "create"
  | "drop"
  | "header"
  | "menu"
  | "options"
  | "package"
  | "remove"
  | "reorder"
  | "swap"
  | "toggle";

const useGuidedSampleStart = (guide: GuidedSample, onStart: () => void, onDismiss: () => void) => {
  const onDismissRef = useRef(onDismiss);
  const onStartRef = useRef(onStart);
  onDismissRef.current = onDismiss;
  onStartRef.current = onStart;
  useEffect(() => {
    const ownerView = guide === "create" ? "creator" : "patcher";
    const startRequestedGuide = (event: Event) => {
      if (!(event instanceof CustomEvent) || event.detail !== guide) return;
      onStartRef.current();
    };
    const dismissHiddenGuide = (event: Event) => {
      if (!(event instanceof CustomEvent) || event.detail === ownerView) return;
      clearGuidedSampleQuery();
      onDismissRef.current();
    };
    window.addEventListener(GUIDED_SAMPLE_START_EVENT, startRequestedGuide);
    window.addEventListener(GUIDED_SAMPLE_VIEW_EVENT, dismissHiddenGuide);
    if (new URLSearchParams(window.location.search).get("guide") === guide) onStartRef.current();
    return () => {
      window.removeEventListener(GUIDED_SAMPLE_START_EVENT, startRequestedGuide);
      window.removeEventListener(GUIDED_SAMPLE_VIEW_EVENT, dismissHiddenGuide);
    };
  }, [guide]);
};

type SampleTutorialStep = {
  actions?: readonly (readonly [action: SampleTutorialAction, label: string])[];
  body: string;
  /** Selector, within the target, for the button this step asks you to press. */
  cta?: string;
  /** Document-level selector for a control that sits outside the target but
      belongs to the step - it is lifted clear of the scrim alongside it. */
  lift?: string;
  openDrawers?: boolean;
  openMenu?: boolean;
  placement?: "bottom" | "top";
  target?: string;
  title: string;
};

const ACTION_ICONS: Record<SampleTutorialAction, ComponentType<Pick<JSX.SVGAttributes, "className">>> = {
  apply: ApplyBandaidIcon,
  archive: Archive,
  checks: ListChecks,
  create: GitCompare,
  drop: Upload,
  header: Scissors,
  menu: EllipsisVertical,
  options: SlidersHorizontal,
  package: Package,
  remove: X,
  reorder: ListOrdered,
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
/** How far the ring sits outside the row it frames. */
const GUIDE_RING_INSET = 7;

type GuideRect = { bottom: number; height: number; left: number; top: number; width: number };

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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
 * gets cut off. The ring is rendered as part of the guide layer instead and
 * simply frames the row's box.
 */
const ringAroundTarget = (rect: GuideRect) => ({
  height: rect.height + GUIDE_RING_INSET * 2,
  left: rect.left - GUIDE_RING_INSET,
  top: rect.top - GUIDE_RING_INSET,
  width: rect.width + GUIDE_RING_INSET * 2,
});
/** Desktop only - below 641px the card stays the full-width bar pinned by CSS. */
const GUIDE_ANCHOR_QUERY = "(min-width: 641px)";

const clampWithin = (value: number, limit: number) =>
  Math.min(Math.max(value, GUIDE_MARGIN), Math.max(GUIDE_MARGIN, limit));

/**
 * Which side of the row the card sits on. A row taller than a chunk of the
 * viewport anchors from its top, so the card lands beside the header the step
 * is describing instead of hundreds of pixels below it - and when the pair
 * cannot fit at all, keeping the row's top on screen matters more than its tail.
 */
const shouldPlaceAbove = (rowHeight: number, prefer: "bottom" | "top") =>
  prefer === "top" || rowHeight > window.innerHeight * GUIDE_TALL_ROW_RATIO;

/**
 * Places the guide card against the row it describes, horizontally centred on
 * it and always kept inside the viewport.
 */
const anchorToTarget = (rect: GuideRect, dialog: HTMLElement, prefer: "bottom" | "top") => {
  const { height, width } = dialog.getBoundingClientRect();
  const above = rect.top - GUIDE_GAP - height;
  const below = rect.bottom + GUIDE_GAP;
  const fitsAbove = above >= GUIDE_MARGIN;
  const fitsBelow = below + height <= window.innerHeight - GUIDE_MARGIN;
  // The reveal scroll parks the row so the preferred side fits, but the user
  // can scroll it anywhere afterwards - take the other side rather than clamp
  // the card back over the row.
  const preferred = shouldPlaceAbove(rect.height, prefer);
  const placeAbove = preferred ? fitsAbove || !fitsBelow : !(fitsBelow || !fitsAbove);
  const top = placeAbove ? above : below;
  return {
    left: clampWithin(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - GUIDE_MARGIN),
    top: clampWithin(top, window.innerHeight - height - GUIDE_MARGIN),
  };
};

/**
 * How far to scroll so the row and its card sit together, centred as a pair
 * when the viewport can hold them. A row too tall to fit alongside the card
 * gives up its bottom edge rather than its top.
 */
const scrollDeltaForPair = (rect: GuideRect, dialog: HTMLElement | null, prefer: "bottom" | "top") => {
  const cardHeight = dialog?.getBoundingClientRect().height ?? 0;
  const pair = rect.height + GUIDE_GAP + cardHeight;
  const slack = Math.max(GUIDE_MARGIN, (window.innerHeight - pair) / 2);
  const desiredTop = shouldPlaceAbove(rect.height, prefer) ? slack + cardHeight + GUIDE_GAP : slack;
  return rect.top - desiredTop;
};

const SampleTutorialStart = ({
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
          startLogger.trace("onboarding beacon toggled", { open: !open });
          setOpen((current) => !current);
        }}
        ref={chipRef}
        type="button"
      >
        <span aria-hidden="true" className="sample-tutorial-start-beacon">
          !
        </span>
        New here?
      </button>
      {/* Mounted only while open: the closed popover would otherwise ship in
          the prerendered shell - four inline SVGs and all - on every page. */}
      {open ? (
        <div className="sample-tutorial-start-pop" id={popId}>
          <span aria-hidden="true" className="sample-tutorial-start-head mono">
            Get started
          </span>
          <a
            aria-busy={loading}
            aria-disabled={loading || undefined}
            className="sample-tutorial-start-action sample-tutorial-start-primary"
            href={guideHref}
            onClick={(event) => {
              if (!isPlainLeftClick(event)) return;
              event.preventDefault();
              if (!loading) onStart();
            }}
          >
            <span aria-hidden="true" className="sample-tutorial-start-action-icon">
              <StartIcon />
            </span>
            {loading ? "Loading practice files…" : label}
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
                if (!loading) onSecondaryStart();
              }}
            >
              <span aria-hidden="true" className="sample-tutorial-start-action-icon">
                <SecondaryIcon />
              </span>
              {loading ? "Loading practice files…" : secondaryLabel}
            </a>
          ) : null}
          <a className="sample-tutorial-start-action sample-tutorial-start-download" download href={href}>
            <Download aria-hidden="true" />
            {downloadLabel}
          </a>
          {error ? <span role="status">{error}</span> : null}
          <button
            className="sample-tutorial-start-dismiss"
            onClick={() => {
              startLogger.debug("onboarding beacon dismissed");
              setOpen(false);
              setDismissed(true);
              requestOnboardingDismiss();
            }}
            type="button"
          >
            Don't show this again
          </button>
        </div>
      ) : null}
    </div>
  );
};

const SampleTutorial = ({
  loadingBody,
  onClose,
  ready,
  steps,
}: {
  loadingBody: string;
  onClose: () => void;
  ready: boolean;
  steps: readonly SampleTutorialStep[];
}) => {
  const bodyId = useId();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const [stepIndex, setStepIndex] = useState(0);
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
  const endGuide = () => {
    clearGuidedSampleQuery();
    onClose();
  };
  const endGuideRef = useRef(endGuide);
  const endedByCtaRef = useRef(false);
  endGuideRef.current = endGuide;
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
    arrivingRef.current = true;
    setMoving(true);
    const exit = dialog.animate(
      { opacity: [1, 0] },
      { duration: GUIDE_EXIT_MS, easing: GUIDE_EXIT_EASE, fill: "forwards" },
    );
    motionRef.current = exit;
    // A cancelled exit rejects; the run that cancelled it owns the card now.
    exit.finished.then(commit, () => undefined);
  }, []);

  useEffect(() => {
    if (live === ready) return;
    beginMove(() => setLive(ready));
  }, [beginMove, live, ready]);

  useEffect(() => () => motionRef.current?.cancel(), []);

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
    const targetSelector = step?.target;
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
      target = document.querySelector<HTMLElement>(targetSelector);
      if (!target) return false;
      stage = target.closest<HTMLElement>(".step");
      setTargetEl(target);
      previousDescription = target.getAttribute("aria-describedby");
      target.classList.add("sample-tutorial-target");
      stage?.classList.add("sample-tutorial-stage");
      target.setAttribute("aria-describedby", [previousDescription, bodyId].filter(Boolean).join(" "));
      if (step.openDrawers) {
        for (const drawer of target.querySelectorAll<HTMLButtonElement>(".cks > .cks-head[aria-expanded='false']")) {
          openedDrawers.push(drawer);
          drawer.click();
        }
      }
      if (step.openMenu) {
        openedMenu = target.querySelector<HTMLButtonElement>(".patch-menu-btn[aria-expanded='false']");
        openedMenu?.click();
      }
      if (step.lift) {
        // The swap control lives between two rows, so no single target can hold
        // it. Lift its row, not the button: .swap-row sets a z-index of its own,
        // so a lift on the button would be scoped inside that stacking context.
        lifted = document.querySelector<HTMLElement>(step.lift);
        lifted?.classList.add("sample-tutorial-lift");
      }
      if (step.cta) {
        // A data attribute, not a class: React rewrites this button's className
        // whenever its download state changes and would drop a class we added.
        cta = target.querySelector<HTMLElement>(step.cta);
        cta?.setAttribute("data-guide-cta", "true");
        removeCtaEndListener = bindFinalCta(cta, stepIndex === steps.length - 1, () => {
          endedByCtaRef.current = true;
          endGuideRef.current();
        });
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
      if (!endedByCtaRef.current) {
        if (openedMenu?.getAttribute("aria-expanded") === "true") openedMenu.click();
        for (const drawer of openedDrawers) {
          if (drawer.getAttribute("aria-expanded") === "true") drawer.click();
        }
      }
      endedByCtaRef.current = false;
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
  }, [bodyId, live, step, stepIndex, steps.length]);

  // Pins the ring and the card to the row in *document* coordinates, so the
  // page scrolls all three together on the compositor and this runs no code
  // per scroll frame at all.
  //
  // Tracking the scroll instead - measure on the event, write a fixed-position
  // box - is what made the ring shake. A scroll is composited without waiting
  // for the main thread, so the row is already painted at its new offset while
  // any JS-driven box still holds the previous one; the highlight rides a frame
  // or more behind the row for the whole gesture and only lines back up once
  // the page stops. No amount of measuring earlier fixes that. Nothing here may
  // re-place on scroll.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const ring = ringRef.current;
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
      const rise = step?.placement === "top" ? -GUIDE_ENTER_RISE : GUIDE_ENTER_RISE;
      motionRef.current = dialog.animate(
        { opacity: [0, 1], translate: [`0 ${rise}px`, "0 0"] },
        { duration: GUIDE_ENTER_MS, easing: GUIDE_ENTER_EASE },
      );
    };
    if (!(targetEl && dialog && ring)) {
      unanchor();
      if (!step?.target) arrive();
      return;
    }
    const prefer = step?.placement ?? "bottom";
    const desktop = window.matchMedia(GUIDE_ANCHOR_QUERY);
    let settle = 0;
    let resizeFrame = 0;
    let revealsLeft = GUIDE_REVEALS;
    let rowHeight = targetEl.getBoundingClientRect().height;
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
      // Below 641px the card stays the CSS-pinned bar; the ring still frames.
      const card = desktop.matches ? anchorToTarget(shiftRect(rect, shift), dialog, prefer) : null;
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
    const placeAndReveal = (glide: boolean) => {
      const top = scrollDeltaForPair(targetEl.getBoundingClientRect(), dialog, prefer);
      // A guide can open at the document boundary, where the ideal pair
      // position asks for a negative scroll that the browser cannot perform.
      // Clamp before placing: otherwise the next ResizeObserver pass sees the
      // unshifted row again and alternates the card between the two positions.
      const minShift = -window.scrollY;
      const documentHeight = document.documentElement.scrollHeight;
      // Layout-free test DOMs report a zero scroll height; leave the upper
      // bound open there so the placement logic remains observable.
      const maxShift =
        documentHeight > 0
          ? Math.max(0, documentHeight - window.innerHeight - window.scrollY)
          : Number.POSITIVE_INFINITY;
      const shift = Math.min(Math.max(Math.abs(top) > 1 ? top : 0, minShift), maxShift);
      place(glide, shift);
      // The ring supplies the visual handoff. Keep the page scroll atomic so
      // responsive remeasurement cannot leave the next control moving under
      // the guide while a browser smooth-scroll animation is still running.
      if (shift) window.scrollBy({ behavior: "auto", top: shift });
    };
    const track = () => place(false);
    // A re-reveal that lands while the user is scrolling fights them for the
    // scroll position, and the page - ring and all - shakes until one of the
    // two wins. Deliberate scroll input retires the rest of this step's
    // re-reveals; the opening one has already run by then.
    const yieldToUser = () => {
      revealsLeft = 0;
      window.clearTimeout(settle);
    };
    // The row grows as its drawers expand, so re-reveal once each size change
    // has stopped - otherwise the card ends up sitting over the row it explains.
    // Gated on the row's own height: the card reflowing, or mobile browser
    // chrome collapsing as the user scrolls, must not scroll the page out from
    // under them. Defer placement until after ResizeObserver delivery because
    // changing the dialog's coordinates inside its own callback can trigger a
    // WebKit loop diagnostic.
    const onResize = () => {
      window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        place(false);
        const height = targetEl.getBoundingClientRect().height;
        if (height === rowHeight) return;
        rowHeight = height;
        if (revealsLeft <= 0) return;
        window.clearTimeout(settle);
        settle = window.setTimeout(() => {
          revealsLeft -= 1;
          placeAndReveal(false);
        }, GUIDE_SETTLE_MS);
      });
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
    desktop.addEventListener("change", track);
    return () => {
      window.clearTimeout(settle);
      window.cancelAnimationFrame(resizeFrame);
      observer.disconnect();
      window.removeEventListener("resize", track);
      window.removeEventListener("wheel", yieldToUser);
      window.removeEventListener("touchmove", yieldToUser);
      window.removeEventListener("keydown", yieldToUser);
      desktop.removeEventListener("change", track);
      // The card is deliberately left where it is: clearing it here would make
      // the next step's placement measure from the CSS-pinned bar and glide
      // across the screen instead of from the card the user is looking at.
    };
  }, [step, targetEl]);

  if (!step) return null;
  const finalStep = live && stepIndex === steps.length - 1;
  const copyKey = live ? stepIndex : "loading";
  const layer = (
    <div className="sample-tutorial-layer">
      <div aria-hidden="true" className="sample-tutorial-scrim" />
      {/* Position, and the glide/anchor flags that go with it, are owned by the
          placement effect - it writes them to the DOM directly so scroll
          tracking is not a render behind the page. */}
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
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <button aria-label="Exit tutorial" className="sample-tutorial-exit" onClick={endGuide} type="button">
          <X aria-hidden="true" />
        </button>
        <span aria-hidden="true" className="sample-tutorial-beacon">
          0x
        </span>
        {/* The live region has to outlive the step copy: a region inserted
            together with its content is never announced, so only the copy
            inside it is keyed per step. */}
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the overflowing tutorial copy must be keyboard-scrollable. */}
        <section aria-label="Tutorial instructions" className="sample-tutorial-copy-area" tabIndex={0}>
          <div aria-live="polite" className="sample-tutorial-live">
            <div className="sample-tutorial-copy" key={copyKey}>
              <span className="sample-tutorial-kicker mono">
                {live ? `Guided workbench · ${stepIndex + 1}/${steps.length}` : "Preparing workbench…"}
              </span>
              <h2 id={titleId}>{live ? step.title : "Loading the practice files"}</h2>
              <p id={bodyId}>{live ? step.body : loadingBody}</p>
              {live ? null : (
                <div
                  aria-label="Loading practice files"
                  aria-valuetext="Preparing the guided workbench"
                  className="sample-tutorial-progress"
                  role="progressbar"
                >
                  <span />
                </div>
              )}
              {live && step.actions?.length ? (
                <ul aria-label="Available actions" className="sample-tutorial-action-list">
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
          {live ? (
            <p className="sample-tutorial-end-hint">
              The top-right X exits; the final action button also ends the tutorial.
            </p>
          ) : null}
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
              Back
            </button>
          ) : null}
          {live ? (
            <button
              className="btn primary slim"
              onClick={() => {
                // A second press mid-handoff would cancel the exit the first one
                // started, stranding the card invisible on a step it never left.
                if (moving) return;
                if (finalStep) endGuide();
                else beginMove(() => setStepIndex((current) => current + 1));
              }}
              type="button"
            >
              {finalStep ? "Done" : "Continue"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
  return layer;
};

export { SampleTutorial, SampleTutorialStart, type SampleTutorialStep, useGuidedSampleStart };
