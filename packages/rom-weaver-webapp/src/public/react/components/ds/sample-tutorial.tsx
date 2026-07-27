import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

type SampleTutorialStep = {
  body: string;
  placement?: "bottom" | "top";
  target?: string;
  title: string;
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
        !
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
  const dialogId = useId();
  const titleId = useId();
  const [stepIndex, setStepIndex] = useState(0);
  const step = steps[stepIndex];

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
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
    let frame = 0;
    const advance = () => setStepIndex((current) => Math.min(current + 1, steps.length - 1));
    const connect = () => {
      if (target) return true;
      target = document.querySelector<HTMLElement>(targetSelector);
      if (!target) return false;
      stage = target.closest<HTMLElement>(".step");
      previousDescription = target.getAttribute("aria-describedby");
      target.classList.add("sample-tutorial-target");
      stage?.classList.add("sample-tutorial-stage");
      target.setAttribute("aria-describedby", [previousDescription, bodyId].filter(Boolean).join(" "));
      target.addEventListener("click", advance, { once: true });
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      target.scrollIntoView?.({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
      target.focus({ preventScroll: true });
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
      target?.removeEventListener("click", advance);
      target?.classList.remove("sample-tutorial-target");
      stage?.classList.remove("sample-tutorial-stage");
      if (target) {
        if (previousDescription) target.setAttribute("aria-describedby", previousDescription);
        else target.removeAttribute("aria-describedby");
      }
    };
  }, [bodyId, ready, step, steps.length]);

  if (typeof document === "undefined" || !step) return null;
  const finalStep = ready && stepIndex === steps.length - 1;
  const copyKey = ready ? stepIndex : "loading";
  const layer = (
    <div className="sample-tutorial-layer">
      <div aria-hidden="true" className="sample-tutorial-scrim" />
      <aside
        aria-labelledby={titleId}
        aria-modal="false"
        className="sample-tutorial-dialog"
        data-placement={ready ? (step.placement ?? "bottom") : "bottom"}
        id={dialogId}
        role="dialog"
      >
        <span aria-hidden="true" className="sample-tutorial-beacon">
          !
        </span>
        <div aria-live="polite" className="sample-tutorial-copy" key={copyKey}>
          <span className="sample-tutorial-kicker mono">
            {ready ? `Practice quest · ${stepIndex + 1}/${steps.length}` : "Reading cartridge…"}
          </span>
          <h2 id={titleId}>{ready ? step.title : "Loading the practice files"}</h2>
          <p id={bodyId}>{ready ? step.body : loadingBody}</p>
          {ready && step.target ? (
            <span className="sample-tutorial-command mono">Click the blinking control ↑</span>
          ) : null}
        </div>
        <div className="sample-tutorial-actions">
          {ready && !step.target ? (
            <button
              className="btn primary slim"
              onClick={() => {
                if (finalStep) onClose();
                else setStepIndex((current) => current + 1);
              }}
              type="button"
            >
              {finalStep ? "Finish tutorial" : "Continue"}
            </button>
          ) : null}
          <button className="btn ghost slim" onClick={onClose} type="button">
            End tutorial
          </button>
        </div>
      </aside>
    </div>
  );
  return createPortal(layer, document.querySelector(".rw-app") || document.body);
};

export { SampleTutorial, SampleTutorialStart, type SampleTutorialStep };
