import {
  Archive,
  ArrowUpDown,
  Download,
  EllipsisVertical,
  GitCompare,
  ListChecks,
  Package,
  Scissors,
  SlidersHorizontal,
  ToggleRight,
  Upload,
  X,
} from "lucide-react";
import type { ComponentType } from "react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApplyBandaidIcon } from "../apply-bandaid-icon.tsx";
import { SwapIcon } from "./swap-icon.tsx";

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

const useGuidedSampleStart = (guide: "apply" | "create", onStart: () => void) => {
  const onStartRef = useRef(onStart);
  const startedRef = useRef(false);
  onStartRef.current = onStart;
  useEffect(() => {
    if (startedRef.current || new URLSearchParams(window.location.search).get("guide") !== guide) return;
    startedRef.current = true;
    onStartRef.current();
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

const ACTION_ICONS: Record<SampleTutorialAction, ComponentType<{ className?: string }>> = {
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
  reorder: ArrowUpDown,
  swap: SwapIcon,
  toggle: ToggleRight,
};

const GUIDE_GAP = 14;
const GUIDE_MARGIN = 12;
/** Drawers expand over .3s, so the row keeps growing after a step opens. */
const GUIDE_SETTLE_MS = 360;
/** Caps the re-reveal so later layout shifts never yank the page around. */
const GUIDE_REVEALS = 3;
/** Above this share of the viewport a row is anchored from its top edge. */
const GUIDE_TALL_ROW_RATIO = 0.45;
/** How far the ring sits outside the row it frames. */
const GUIDE_RING_INSET = 7;

type GuideRect = { bottom: number; height: number; left: number; top: number; width: number };

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
  label,
  loading,
  onStart,
}: {
  downloadHref: string;
  downloadLabel: string;
  downloadName: string;
  error: string;
  label: string;
  loading: boolean;
  onStart: () => void;
}) => {
  // The resolved href depends on where the app is served, which the prerender
  // cannot know. Render the root-relative form the server emits, then upgrade
  // after hydration so a sub-path deployment still links correctly.
  const [href, setHref] = useState(`/${downloadName}`);
  useEffect(() => setHref(downloadHref), [downloadHref]);
  return (
    <div className="first-weave-demo sample-tutorial-start">
      <span>New here?</span>
      <a className="btn slim sample-tutorial-start-download" download href={href}>
        <Download aria-hidden="true" />
        {downloadLabel}
      </a>
      <span className="sample-tutorial-start-or">or</span>
      <button aria-busy={loading} className="btn ghost slim" disabled={loading} onClick={onStart} type="button">
        <span aria-hidden="true" className="sample-tutorial-start-beacon">
          0x
        </span>
        {loading ? "Loading practice files…" : label}
      </button>
      {error ? <span role="status">{error}</span> : null}
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
  const step = steps[stepIndex];
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
    if (!(ready && targetSelector)) return;
    let target: HTMLElement | null = null;
    let stage: HTMLElement | null = null;
    let previousDescription: string | null = null;
    let observer: MutationObserver | null = null;
    let openedMenu: HTMLButtonElement | null = null;
    let cta: HTMLElement | null = null;
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
      cta?.removeAttribute("data-guide-cta");
      lifted?.classList.remove("sample-tutorial-lift");
      target?.classList.remove("sample-tutorial-target");
      stage?.classList.remove("sample-tutorial-stage");
      if (target) {
        if (previousDescription) target.setAttribute("aria-describedby", previousDescription);
        else target.removeAttribute("aria-describedby");
      }
    };
  }, [bodyId, ready, step]);

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
    if (!(targetEl && dialog && ring)) {
      unanchor();
      return;
    }
    const prefer = step?.placement ?? "bottom";
    const desktop = window.matchMedia(GUIDE_ANCHOR_QUERY);
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    let settle = 0;
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
      setGlide(dialog, glide && card !== null);
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
      const shift = Math.abs(top) > 1 ? top : 0;
      place(glide, shift);
      if (shift) window.scrollBy({ behavior, top: shift });
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
    // under them.
    const onResize = () => {
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
    };
    const observer = new ResizeObserver(onResize);
    placeAndReveal(true);
    observer.observe(targetEl);
    observer.observe(dialog);
    window.addEventListener("resize", track);
    window.addEventListener("wheel", yieldToUser, { passive: true });
    window.addEventListener("touchmove", yieldToUser, { passive: true });
    window.addEventListener("keydown", yieldToUser);
    desktop.addEventListener("change", track);
    return () => {
      window.clearTimeout(settle);
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

  if (!(portalTarget && step)) return null;
  const finalStep = ready && stepIndex === steps.length - 1;
  const copyKey = ready ? stepIndex : "loading";
  const layer = (
    <div className="sample-tutorial-layer">
      <div aria-hidden="true" className="sample-tutorial-scrim" />
      {/* Position, and the glide/anchor flags that go with it, are owned by the
          placement effect - it writes them to the DOM directly so scroll
          tracking is not a render behind the page. */}
      {targetEl ? <div aria-hidden="true" className="sample-tutorial-ring" ref={ringRef} /> : null}
      <div
        aria-describedby={bodyId}
        aria-labelledby={titleId}
        aria-modal="false"
        className="sample-tutorial-dialog"
        data-placement={ready ? (step.placement ?? "bottom") : "bottom"}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <span aria-hidden="true" className="sample-tutorial-beacon">
          0x
        </span>
        {/* The live region has to outlive the step copy: a region inserted
            together with its content is never announced, and the key below
            remounts the copy on every step to restart its entry animation. */}
        <div aria-live="polite" className="sample-tutorial-live">
          <div className="sample-tutorial-copy" key={copyKey}>
            <span className="sample-tutorial-kicker mono">
              {ready ? `Guided workbench · ${stepIndex + 1}/${steps.length}` : "Preparing workbench…"}
            </span>
            <h2 id={titleId}>{ready ? step.title : "Loading the practice files"}</h2>
            <p id={bodyId}>{ready ? step.body : loadingBody}</p>
            {ready && step.actions?.length ? (
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
        <div className="sample-tutorial-actions">
          {ready ? (
            <button
              className="btn primary slim"
              onClick={() => {
                if (finalStep) onClose();
                else setStepIndex((current) => current + 1);
              }}
              type="button"
            >
              {finalStep ? "Done" : "Continue"}
            </button>
          ) : null}
          <button className="btn ghost slim" onClick={onClose} type="button">
            End guide
          </button>
        </div>
      </div>
    </div>
  );
  return createPortal(layer, portalTarget);
};

export { SampleTutorial, SampleTutorialStart, type SampleTutorialStep, useGuidedSampleStart };
