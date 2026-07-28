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
import { useEffect, useId, useMemo, useRef, useState } from "react";
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
type SampleTutorialStep = {
  actions?: readonly (readonly [action: SampleTutorialAction, label: string])[];
  body: string;
  /** Selector, within the target, for the button this step asks you to press. */
  cta?: string;
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

type GuideGeometry = {
  card: { left: number; top: number } | null;
  glide: boolean;
  ring: { height: number; left: number; top: number; width: number };
};

/**
 * The row's own ancestors are `overflow: clip`, so an outline drawn on the row
 * gets cut off. The ring is rendered in the guide's portal instead and simply
 * tracks the row's box.
 */
const ringAroundTarget = (target: HTMLElement) => {
  const rect = target.getBoundingClientRect();
  return {
    height: rect.height + GUIDE_RING_INSET * 2,
    left: rect.left - GUIDE_RING_INSET,
    top: rect.top - GUIDE_RING_INSET,
    width: rect.width + GUIDE_RING_INSET * 2,
  };
};
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
const anchorToTarget = (target: HTMLElement, dialog: HTMLElement, prefer: "bottom" | "top") => {
  const rect = target.getBoundingClientRect();
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
const scrollDeltaForPair = (target: HTMLElement, dialog: HTMLElement | null, prefer: "bottom" | "top") => {
  const rect = target.getBoundingClientRect();
  const cardHeight = dialog?.getBoundingClientRect().height ?? 0;
  const pair = rect.height + GUIDE_GAP + cardHeight;
  const slack = Math.max(GUIDE_MARGIN, (window.innerHeight - pair) / 2);
  const desiredTop = shouldPlaceAbove(rect.height, prefer) ? slack + cardHeight + GUIDE_GAP : slack;
  return rect.top - desiredTop;
};

const SampleTutorialStart = ({
  downloadHref,
  downloadLabel,
  error,
  label,
  loading,
  onStart,
}: {
  downloadHref: string;
  downloadLabel: string;
  error: string;
  label: string;
  loading: boolean;
  onStart: () => void;
}) => (
  <div className="first-weave-demo sample-tutorial-start">
    <span>New here?</span>
    <a className="btn slim sample-tutorial-start-download" download href={downloadHref}>
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
  const dialogRef = useRef<HTMLElement>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [targetEl, setTargetEl] = useState<HTMLElement | null>(null);
  const [geometry, setGeometry] = useState<GuideGeometry | null>(null);
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
      target?.classList.remove("sample-tutorial-target");
      stage?.classList.remove("sample-tutorial-stage");
      if (target) {
        if (previousDescription) target.setAttribute("aria-describedby", previousDescription);
        else target.removeAttribute("aria-describedby");
      }
    };
  }, [bodyId, ready, step]);

  // Keep the card beside its row as the page scrolls or resizes. The step's own
  // scrollIntoView animates, so this re-measures per frame while that settles.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!(targetEl && dialog)) {
      setGeometry(null);
      return;
    }
    const prefer = step?.placement ?? "bottom";
    const desktop = window.matchMedia(GUIDE_ANCHOR_QUERY);
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    let frame = 0;
    let settle = 0;
    let revealsLeft = GUIDE_REVEALS;
    const place = (glide: boolean) => {
      frame = 0;
      setGeometry({
        // Below 641px the card stays the CSS-pinned bar; the ring still tracks.
        card: desktop.matches ? anchorToTarget(targetEl, dialog, prefer) : null,
        glide,
        ring: ringAroundTarget(targetEl),
      });
    };
    // Scroll and resize must track exactly - gliding there would leave the card
    // lagging behind the row it points at while the page is still moving.
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(() => place(false));
    };
    const reveal = () => {
      const top = scrollDeltaForPair(targetEl, dialog, prefer);
      if (Math.abs(top) > 1) window.scrollBy({ behavior, top });
    };
    // The row grows as its drawers expand, so re-reveal once each size change
    // has stopped - otherwise the card ends up sitting over the row it explains.
    const onResize = () => {
      schedule();
      if (revealsLeft <= 0) return;
      window.clearTimeout(settle);
      settle = window.setTimeout(() => {
        revealsLeft -= 1;
        reveal();
      }, GUIDE_SETTLE_MS);
    };
    const observer = new ResizeObserver(onResize);
    place(true);
    reveal();
    observer.observe(targetEl);
    observer.observe(dialog);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    desktop.addEventListener("change", schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.clearTimeout(settle);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, { capture: true });
      desktop.removeEventListener("change", schedule);
    };
  }, [step, targetEl]);

  if (!(portalTarget && step)) return null;
  const finalStep = ready && stepIndex === steps.length - 1;
  const copyKey = ready ? stepIndex : "loading";
  const layer = (
    <div className="sample-tutorial-layer">
      <div aria-hidden="true" className="sample-tutorial-scrim" />
      {geometry ? (
        <div
          aria-hidden="true"
          className="sample-tutorial-ring"
          data-glide={geometry.glide ? "true" : undefined}
          style={{
            height: `${geometry.ring.height}px`,
            left: `${geometry.ring.left}px`,
            top: `${geometry.ring.top}px`,
            width: `${geometry.ring.width}px`,
          }}
        />
      ) : null}
      <aside
        aria-describedby={bodyId}
        aria-labelledby={titleId}
        aria-modal="false"
        className="sample-tutorial-dialog"
        data-anchored={geometry?.card ? "true" : undefined}
        data-glide={geometry?.card && geometry.glide ? "true" : undefined}
        data-placement={ready ? (step.placement ?? "bottom") : "bottom"}
        ref={dialogRef}
        role="dialog"
        style={geometry?.card ? { left: `${geometry.card.left}px`, top: `${geometry.card.top}px` } : undefined}
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
      </aside>
    </div>
  );
  return createPortal(layer, portalTarget);
};

export { SampleTutorial, SampleTutorialStart, type SampleTutorialStep };
