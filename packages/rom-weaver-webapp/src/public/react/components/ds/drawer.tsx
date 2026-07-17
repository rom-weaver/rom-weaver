import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.js";
import { type ReactNode, useId, useState } from "react";
import { join } from "./cx.ts";

/**
 * Loom collapsible drawer - the "summary-first" card section: a quiet chevron,
 * the label, then the section's key values as recessed readout chips on the
 * right. The body collapses via the CSS grid-rows trick (`.cks` rules); this
 * component only flips `is-open` + aria-expanded. Replaces the old
 * `<details>`-based sections so the open/close animates everywhere.
 */

/** Recessed readout chip for a drawer header (counts, sizes, timings). */
const DrawerReadout = ({ children, muted, time }: { children: ReactNode; muted?: boolean; time?: boolean }) => (
  <span className={join("rb mono", muted && "muted", time && "time")}>{children}</span>
);

/** Pass/fail mark riding beside the readout chips (bare icon, not a pill). */
const DrawerMark = ({
  ok,
  title,
  className,
  children,
}: {
  ok: boolean;
  title?: string;
  className?: string;
  children: ReactNode;
}) => (
  <span className={join("rb-mark", ok ? "ok" : "bad", className)} title={title}>
    {children}
  </span>
);

const Drawer = ({
  action,
  label,
  labelIcon,
  readouts,
  defaultOpen = false,
  open,
  onToggle,
  className,
  bodyClassName = "ckrows",
  children,
}: {
  /** Independent trailing control, rendered beside rather than inside the drawer toggle. */
  action?: ReactNode;
  label: ReactNode;
  /** Optional icon inside the label (e.g. the options "tune" glyph). */
  labelIcon?: ReactNode;
  /** Right-edge readout chips / marks ({@link DrawerReadout}, {@link DrawerMark}). */
  readouts?: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  className?: string;
  /** Class of the wrapper inside the drawer body (`ckrows`, `trackrows`, `optsbody`, …). */
  bodyClassName?: string;
  children: ReactNode;
}) => {
  const bodyId = useId();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isOpen = open ?? uncontrolledOpen;
  const toggle = () => {
    const next = !isOpen;
    if (open === undefined) setUncontrolledOpen(next);
    onToggle?.(next);
  };
  return (
    <div className={join("cks", className, isOpen && "is-open")}>
      <button aria-controls={bodyId} aria-expanded={isOpen} className="cks-head" onClick={toggle} type="button">
        <ChevronRight aria-hidden="true" className="chev" />
        <span className={join("lab", labelIcon ? "opts-lab" : false)}>
          {labelIcon}
          {label}
        </span>
        {readouts ? <span className="readouts">{readouts}</span> : null}
      </button>
      {action ? <span className="drawer-action">{action}</span> : null}
      <div className="cks-body" id={bodyId}>
        <div className="cks-inner">
          <div className={bodyClassName}>{children}</div>
        </div>
      </div>
    </div>
  );
};

export { Drawer, DrawerMark, DrawerReadout };
