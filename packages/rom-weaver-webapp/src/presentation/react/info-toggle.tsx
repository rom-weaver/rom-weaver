import { Info } from "lucide-preact";
import type { CSSProperties, ComponentChildren } from "preact";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "preact/hooks";

const cx = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ");

function InfoToggle({
  ariaLabel,
  children,
  className,
  icon,
  panelClassName,
  portalPanel,
  title,
}: {
  ariaLabel: string;
  children: ComponentChildren;
  className?: string;
  icon?: ComponentChildren;
  panelClassName?: string;
  portalPanel?: boolean;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [panelStyle, setPanelStyle] = useState<CSSProperties | undefined>(undefined);
  const panelId = useId();

  const computePanelPosition = useCallback(() => {
    if (typeof window === "undefined") return;
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
  }, []);

  useLayoutEffect(() => {
    if (!(portalPanel && open)) return;
    computePanelPosition();
  }, [open, portalPanel, computePanelPosition]);

  useEffect(() => {
    if (!(portalPanel && open) || typeof window === "undefined") return;
    const handleReposition = () => computePanelPosition();
    // Both consumers live inside scrollable panels; scroll events don't bubble, so listen
    // in the capture phase to catch any ancestor scroll container and keep the fixed
    // popover pinned to its trigger (and re-clamped to the viewport) instead of floating.
    window.addEventListener("scroll", handleReposition, true);
    window.addEventListener("resize", handleReposition);
    return () => {
      window.removeEventListener("scroll", handleReposition, true);
      window.removeEventListener("resize", handleReposition);
    };
  }, [open, portalPanel, computePanelPosition]);

  const panel = (
    <section
      aria-label={title}
      className={cx("info-pop", panelClassName)}
      id={panelId}
      ref={panelRef}
      // Fixed placement keeps the explicitly requested panel above its local stacking context.
      style={portalPanel ? { display: "block", position: "fixed", zIndex: 80, ...panelStyle } : { display: "block" }}
    >
      {children}
    </section>
  );
  const renderedPanel: ComponentChildren = open ? panel : null;

  return (
    <span className={cx("info", className)}>
      <button
        aria-controls={panelId}
        aria-expanded={open}
        aria-label={ariaLabel}
        className="info-btn"
        onClick={() => {
          if (!open) setPanelStyle(undefined);
          setOpen((currentOpen) => !currentOpen);
        }}
        ref={buttonRef}
        title={title}
        type="button"
      >
        {icon ?? <Info aria-hidden="true" />}
      </button>
      {renderedPanel}
    </span>
  );
}

export { InfoToggle };
