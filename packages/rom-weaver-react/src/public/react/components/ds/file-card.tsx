import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import Crosshair from "lucide-react/dist/esm/icons/crosshair.js";
import X from "lucide-react/dist/esm/icons/x.js";
import type { CSSProperties, ReactNode, Ref } from "react";
import { join } from "./cx.ts";

/**
 * Loom file card for every workflow's input rows. The header is two columns:
 * the name (with its size·type sub-line) on the left and the action buttons
 * (drag handle / remove) on the right; the collapsible drawers (extraction
 * tree, checksums, options) follow as children. Verdict borders (ok / warn /
 * bad) belong to patches; ROM cards keep the plain seam border.
 */

type FileState = "ok" | "bad" | "warn";

/** Clear/remove button in the card's action column. */
const RemoveButton = ({ onClick, label }: { onClick: () => void; label: string }) => (
  <button aria-label={label} className="rm" onClick={onClick} title={label} type="button">
    <X aria-hidden="true" />
  </button>
);

/** "Apply patch to" target group shown on a patch's meta line. */
const FileTargetPill = ({ label, bad, onClick }: { label: ReactNode; bad?: boolean; onClick?: () => void }) => (
  <span className={join("target-grp", bad && "bad")}>
    <Crosshair aria-hidden="true" />
    {onClick ? (
      <button aria-label="Apply patch to" className="meta-target-select mono ptgt-sel" onClick={onClick} type="button">
        <span className="ptgt-name">{label}</span>
        <ChevronDown aria-hidden="true" className="ptgt-chev" />
      </button>
    ) : (
      <span className="meta-target-static mono">{label}</span>
    )}
  </span>
);

const FileCard = ({
  state,
  inputMatch,
  index,
  hideName = false,
  onRemove,
  removeLabel = "Remove",
  patch = false,
  handle,
  rootRef,
  className,
  style,
  name,
  description,
  meta,
  target,
  stageBar,
  verifyBar = false,
  children,
}: {
  state?: FileState;
  inputMatch?: boolean;
  index?: number;
  hideName?: boolean;
  onRemove?: () => void;
  removeLabel?: string;
  /** Mark this as a patch row (reorderable unit). */
  patch?: boolean;
  /** Drag handle button for reorderable rows, rendered in the action column. */
  handle?: ReactNode;
  rootRef?: Ref<HTMLDivElement>;
  className?: string;
  style?: CSSProperties;
  name: ReactNode;
  /** Optional description line rendered directly under the name, above the meta sub-line. */
  description?: ReactNode;
  /** size · format sub-line under the name (`.card-meta` content). */
  meta?: ReactNode;
  target?: ReactNode;
  /**
   * Progress bar on the card's top edge while staging: a determinate width
   * (0–100) when the percent is known, or `"indeterminate"` for an animated
   * sliding bar. Omit/null to render no bar - the bar is removed once the work
   * finishes (the meta-line status is what carries completion).
   */
  stageBar?: number | "indeterminate" | null;
  /**
   * The second, verification phase (a patch's deferred dry-run against the ROM):
   * an indeterminate bar on the top edge, shown after staging clears. Same orange
   * accent as the staging bar - it just marks a later phase of the same card.
   */
  verifyBar?: boolean;
  children?: ReactNode;
}) => (
  <div
    className={join(
      "card file",
      state,
      inputMatch && "im",
      patch && "grabbable patch",
      (stageBar != null || verifyBar) && "has-stage-bar",
      className,
    )}
    ref={rootRef}
    style={style}
  >
    {stageBar == null ? null : (
      <div
        aria-hidden="true"
        className={join("stage-bar", stageBar === "indeterminate" && "is-indeterminate")}
        style={stageBar === "indeterminate" ? undefined : { width: `${Math.max(0, Math.min(100, stageBar))}%` }}
      />
    )}
    {stageBar == null && verifyBar ? (
      <div aria-hidden="true" className="stage-bar verify-bar is-indeterminate" />
    ) : null}
    {hideName ? (
      onRemove ? (
        <RemoveButton label={removeLabel} onClick={onRemove} />
      ) : null
    ) : (
      <div className="card-top">
        <div className="card-name">
          {typeof index === "number" ? <span className="sr-only">{index}</span> : null}
          {name}
          {description}
          {meta || target ? (
            <span className="card-meta">
              {target}
              {meta}
            </span>
          ) : null}
        </div>
        <div className="card-actions">
          <div className="card-btns">
            {handle}
            {onRemove ? <RemoveButton label={removeLabel} onClick={onRemove} /> : null}
          </div>
        </div>
      </div>
    )}
    {children}
  </div>
);

export { FileCard, FileTargetPill, RemoveButton };
