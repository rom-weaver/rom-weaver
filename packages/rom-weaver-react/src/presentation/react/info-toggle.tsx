import { type CSSProperties, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "../tailwind-classes.ts";

/** Popovers portal into the styled app root so the design-system `.info-pop` rules apply. */
const getInfoPortalTarget = (): Element =>
  (typeof document === "undefined" ? null : document.querySelector(".rw-app")) ?? document.body;

function InfoToggle({
  ariaLabel,
  children,
  className,
  panelClassName,
  portalPanel,
  title,
}: {
  ariaLabel: string;
  children: ReactNode;
  className?: string;
  panelClassName?: string;
  portalPanel?: boolean;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [panelStyle, setPanelStyle] = useState<CSSProperties | undefined>(undefined);
  const panelId = useId();

  useLayoutEffect(() => {
    if (!(portalPanel && open) || typeof window === "undefined") return;
    const panel = panelRef.current;
    const button = buttonRef.current;
    if (!(panel && button)) return;

    const viewportMargin = 12;
    const gap = 6;
    const summaryRect = button.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const maxLeft = window.innerWidth - panelRect.width - viewportMargin;
    const left = Math.max(viewportMargin, Math.min(summaryRect.left, maxLeft));
    const belowTop = summaryRect.bottom + gap;
    const aboveTop = summaryRect.top - panelRect.height - gap;
    const top =
      belowTop + panelRect.height <= window.innerHeight - viewportMargin
        ? belowTop
        : Math.max(viewportMargin, aboveTop);
    setPanelStyle({ left, top });
  }, [open, portalPanel]);

  useEffect(() => {
    if (!(open && typeof document !== "undefined")) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (containerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const panel = (
    <div
      className={cx("info-pop", panelClassName)}
      id={panelId}
      ref={panelRef}
      // Portaled out of the trigger: render fixed, above the modal stacking context (z-60/70).
      style={portalPanel ? { display: "block", position: "fixed", zIndex: 80, ...panelStyle } : { display: "block" }}
    >
      {children}
    </div>
  );
  let renderedPanel: ReactNode = null;
  if (open) {
    renderedPanel = portalPanel && typeof document !== "undefined" ? createPortal(panel, getInfoPortalTarget()) : panel;
  }

  return (
    <span className={cx("info", className)} ref={containerRef}>
      <button
        aria-controls={panelId}
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => {
          if (!open) setPanelStyle(undefined);
          setOpen((currentOpen) => !currentOpen);
        }}
        ref={buttonRef}
        title={title}
        type="button"
      >
        i
      </button>
      {renderedPanel}
    </span>
  );
}

export { InfoToggle };
