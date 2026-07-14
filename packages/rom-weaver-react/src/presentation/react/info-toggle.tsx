import Info from "lucide-react/dist/esm/icons/info.js";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

const cx = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ");

/** Popovers portal into the styled app root so the design-system `.info-pop` rules apply. */
const getInfoPortalTarget = (): Element =>
  (typeof document === "undefined" ? null : document.querySelector(".rw-app")) ?? document.body;

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
  children: ReactNode;
  className?: string;
  icon?: ReactNode;
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
