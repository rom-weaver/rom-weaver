import {
  Archive,
  ArrowUpDown,
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
  openDrawers?: boolean;
  openMenu?: boolean;
  placement?: "bottom" | "top";
  scrollBlock?: ScrollLogicalPosition;
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

const SampleTutorialStart = ({
  error,
  label,
  loading,
  onStart,
}: {
  error: string;
  label: string;
  loading: boolean;
  onStart: () => void;
}) => (
  <div className="first-weave-demo sample-tutorial-start">
    <span>New here?</span>
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
    const openedDrawers: HTMLButtonElement[] = [];
    let frame = 0;
    const connect = () => {
      if (target) return true;
      target = document.querySelector<HTMLElement>(targetSelector);
      if (!target) return false;
      stage = target.closest<HTMLElement>(".step");
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
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      target.scrollIntoView?.({ behavior: reducedMotion ? "auto" : "smooth", block: step.scrollBlock ?? "center" });
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
      if (openedMenu?.getAttribute("aria-expanded") === "true") openedMenu.click();
      for (const drawer of openedDrawers) {
        if (drawer.getAttribute("aria-expanded") === "true") drawer.click();
      }
      target?.classList.remove("sample-tutorial-target");
      stage?.classList.remove("sample-tutorial-stage");
      if (target) {
        if (previousDescription) target.setAttribute("aria-describedby", previousDescription);
        else target.removeAttribute("aria-describedby");
      }
    };
  }, [bodyId, ready, step]);

  if (!(portalTarget && step)) return null;
  const finalStep = ready && stepIndex === steps.length - 1;
  const copyKey = ready ? stepIndex : "loading";
  const layer = (
    <div className="sample-tutorial-layer">
      <div aria-hidden="true" className="sample-tutorial-scrim" />
      <aside
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
      </aside>
    </div>
  );
  return createPortal(layer, portalTarget);
};

export { SampleTutorial, SampleTutorialStart, type SampleTutorialStep };
