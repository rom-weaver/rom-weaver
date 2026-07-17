import CircleX from "lucide-react/dist/esm/icons/circle-x.js";
import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert.js";
import X from "lucide-react/dist/esm/icons/x.js";
import type { CSSProperties, ReactNode } from "react";
import { join } from "./cx.ts";

/**
 * Loom feedback primitives: notices, the weave meter, the recessed progress
 * panels, and the run/download button. Pure presentational components used by
 * every workflow so progress and status rendering is never duplicated.
 */

type NoticeLevel = "error" | "warn";

const Notice = ({
  level,
  id,
  children,
  className,
  dismissLabel = "Dismiss",
  onDismiss,
}: {
  level: NoticeLevel;
  id?: string;
  children: ReactNode;
  className?: string;
  dismissLabel?: string;
  onDismiss?: () => void;
}) => {
  const Icon = level === "error" ? CircleX : TriangleAlert;
  return (
    <div className={join("notice", level, className)} id={id} role={level === "error" ? "alert" : "status"}>
      <Icon aria-hidden="true" />
      <span className="body notice-copy">{children}</span>
      {onDismiss ? (
        <button aria-label={dismissLabel} className="x notice-x" onClick={onDismiss} title={dismissLabel} type="button">
          <X aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
};

/**
 * The weave meter: a recessed track whose fill carries the moving weave sheen
 * while live. Determinate when `percent` is a number, indeterminate otherwise
 * (a sliver bounces across).
 */
const ProgressTrack = ({
  percent,
  indeterminate,
  className,
}: {
  percent?: number | null;
  indeterminate?: boolean;
  className?: string;
}) => {
  const clamped = typeof percent === "number" && Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
  const isIndeterminate = indeterminate || clamped === null;
  // The fill scales instead of resizing: progress ticks arrive per frame
  // during extraction, and animating width forces layout every tick.
  return (
    <div aria-hidden="true" className={join("meter track live", isIndeterminate && "indet", className)}>
      <div
        className="fill bar"
        // --scale (not an inline transform) so the stylesheet can counter-scale
        // the cloth texture and shuttle inside the scaled fill
        style={isIndeterminate ? undefined : ({ "--scale": (clamped ?? 0) / 100 } as CSSProperties)}
      />
    </div>
  );
};

/**
 * Labeled progress: the stage label above the meter, with the percentage (or
 * status word) as the accented readout at the panel's right edge.
 */
const InlineProgress = ({
  label,
  value,
  percent,
  indeterminate,
  tight,
  id,
  onCancel,
  cancelLabel = "Cancel operation",
}: {
  label: ReactNode;
  value?: ReactNode;
  percent?: number | null;
  indeterminate?: boolean;
  tight?: boolean;
  id?: string;
  onCancel?: () => void;
  cancelLabel?: string;
}) => {
  const progress = (
    <div className={join("prog", tight && "tight")}>
      <div className="lab">
        <span className="what">{label}</span>
      </div>
      <ProgressTrack indeterminate={indeterminate} percent={percent} />
      <div className="sub mono">
        <span />
        <span className="run-pct">{value ?? ""}</span>
      </div>
    </div>
  );
  if (!onCancel) {
    return (
      <div className="iprog-wrap" id={id}>
        {progress}
      </div>
    );
  }
  return (
    <div className="prog-panel runprog" id={id}>
      {progress}
      <div className="prog-actions">
        <button aria-label={cancelLabel} className="cancel" onClick={onCancel} title={cancelLabel} type="button">
          <X aria-hidden="true" />
        </button>
      </div>
    </div>
  );
};

type FileProgressProps = Parameters<typeof InlineProgress>[0];

/**
 * {@link InlineProgress} in the bordered, recessed instrument panel, for in-row
 * file work. `run` swaps the bordered box for the borderless full-width run
 * panel (the apply form's live-run look) so the output-step progress lines up
 * with the card content above it.
 */
const FileProgress = ({
  onCancel,
  cancelLabel = "Cancel operation",
  id,
  run,
  ...progress
}: FileProgressProps & { run?: boolean }) => (
  <div aria-busy="true" className={join("prog-panel fileprog", run && "runprog")} id={id}>
    <div className="prog">
      <div className="lab">
        <span className="what">{progress.label}</span>
      </div>
      <ProgressTrack indeterminate={progress.indeterminate} percent={progress.percent} />
      <div className="sub mono">
        <span />
        <span className="run-pct">{progress.value ?? "-"}</span>
      </div>
    </div>
    {onCancel ? (
      <div className="prog-actions">
        <button
          aria-label={cancelLabel}
          className="cancel stage-cancel"
          onClick={onCancel}
          title={cancelLabel}
          type="button"
        >
          <X aria-hidden="true" />
        </button>
      </div>
    ) : null}
  </div>
);

type DownloadMeta = {
  format?: string;
  name?: string;
  ratio?: string;
  savedSize?: string;
  size?: string;
  /** Total wall time, pushed to the button's right edge. */
  total?: string;
};

/**
 * The primary action button. Renders the uppercase action by default, or the
 * download summary (kind · size · detail) when `download` is provided.
 */
const RunButton = ({
  onClick,
  disabled,
  icon,
  children,
  download,
  ariaLabel,
  id,
  type = "button",
}: {
  onClick?: () => void;
  disabled?: boolean;
  icon?: ReactNode;
  children?: ReactNode;
  download?: DownloadMeta;
  /** Accessible label (e.g. the full output filename behind a format-only face). */
  ariaLabel?: string;
  id?: string;
  type?: "button" | "submit";
}) => (
  <button
    aria-label={ariaLabel}
    className={join("btn primary run", download && "download-btn dl")}
    disabled={disabled}
    id={id}
    onClick={onClick}
    type={type}
  >
    {icon}
    {download ? (
      <>
        <span className="sr-only">Download </span>
        {download.format ? <span className="dl-kind mono dl-fmt">{download.format}</span> : null}
        {download.name ? <span className="dl-delta mono dl-name">{download.name}</span> : null}
        {download.size ? (
          <span className="dl-size mono dl-sz">
            {download.size}
            {download.savedSize ? <> &middot; saved {download.savedSize}</> : null}
            {download.ratio ? <> &middot; {download.ratio}</> : null}
          </span>
        ) : null}
        {download.total ? (
          <span className="dl-total mono">
            <b>{download.total}</b>
          </span>
        ) : null}
      </>
    ) : (
      children
    )}
  </button>
);

export { type DownloadMeta, FileProgress, type FileProgressProps, InlineProgress, Notice, ProgressTrack, RunButton };
