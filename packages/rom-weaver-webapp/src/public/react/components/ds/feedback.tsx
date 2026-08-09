import { CircleX, TriangleAlert, X } from "lucide-react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { copyToClipboard } from "../../../../lib/clipboard.ts";
import { join } from "./cx.ts";
import { prefersReducedMotion } from "./flat-transition.ts";

/**
 * Loom feedback primitives: notices, the weave meter, the recessed progress
 * panels, and the run/download button. Pure presentational components used by
 * every workflow so progress and status rendering is never duplicated.
 */

type NoticeLevel = "error" | "warn";

/**
 * The machine error code, demoted to a tag under the copy. It is worthless to a
 * reader mid-task but the first thing a bug report needs, so it is small, last,
 * and copies to the clipboard on click.
 */
const NoticeCode = ({ code }: { code: string }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="notice-code mono"
      onClick={() => {
        void copyToClipboard(code).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      }}
      title={`Copy the error code ${code}`}
      type="button"
    >
      {code}
      <span className="sr-only">{copied ? " copied" : " - click to copy"}</span>
    </button>
  );
};

const Notice = ({
  level,
  id,
  children,
  className,
  code,
  actions,
  dismissLabel = "Dismiss",
  onDismiss,
}: {
  level: NoticeLevel;
  id?: string;
  children: ReactNode;
  className?: string;
  /** Machine error code, rendered as a small copyable tag below the copy. */
  code?: string;
  /** Recovery controls (Retry, open Status, …) rendered under the copy. */
  actions?: ReactNode;
  dismissLabel?: string;
  onDismiss?: () => void;
}) => {
  const Icon = level === "error" ? CircleX : TriangleAlert;
  return (
    <div className={join("notice", level, className)} id={id} role={level === "error" ? "alert" : "status"}>
      <Icon aria-hidden="true" />
      <span className="body notice-copy">
        {children}
        {actions || code ? (
          <span className="notice-actions">
            {actions}
            {code ? <NoticeCode code={code} /> : null}
          </span>
        ) : null}
      </span>
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
          <span aria-hidden="true" className="cancel-text">
            Cancel
          </span>
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
          <span aria-hidden="true" className="cancel-text">
            Cancel
          </span>
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

const RunButtonDownloadSummary = ({ download }: { download: DownloadMeta }) => (
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
);

/**
 * A finished run swaps the progress panel for a shorter result, so the button
 * that carries the download can land below the fold - or behind the phone dock,
 * which is fixed over the end of the column. `nearest` scrolls the least amount
 * that makes it visible, and its scroll margin (buttons.css) is what clears the
 * dock, so a button already in view does not move at all.
 */
const isFullyInViewport = (element: HTMLElement): boolean => {
  const rect = element.getBoundingClientRect();
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  return rect.top >= 0 && rect.bottom <= viewportHeight;
};

const useRevealFinishedDownload = (button: RefObject<HTMLButtonElement | null>, download?: DownloadMeta) => {
  const offered = useRef(Boolean(download));
  // Set by any scroll after the run starts. Moving the page during a long run is
  // a deliberate choice (reading the log, checking another card); yanking the
  // view back to the button at the end would undo it.
  const userScrolled = useRef(false);
  useEffect(() => {
    const onScroll = () => {
      userScrolled.current = true;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    const offering = Boolean(download);
    const wasOffering = offered.current;
    offered.current = offering;
    if (!offering || wasOffering || userScrolled.current) return;
    const element = button.current;
    if (!element || isFullyInViewport(element)) return;
    element.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "nearest" });
  }, [button, download]);
  // Pressing the button is the run's start: it was on screen at that instant, so
  // any scroll after it is the user moving away on purpose.
  return () => {
    userScrolled.current = false;
  };
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
}) => {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const markRunStart = useRevealFinishedDownload(buttonRef, download);
  return (
    <button
      aria-label={ariaLabel}
      className={join("btn primary run", download && "download-btn dl")}
      disabled={disabled}
      id={id}
      onClick={() => {
        markRunStart();
        onClick?.();
      }}
      ref={buttonRef}
      type={type}
    >
      {icon}
      {download ? <RunButtonDownloadSummary download={download} /> : children}
    </button>
  );
};

export { type DownloadMeta, FileProgress, type FileProgressProps, InlineProgress, Notice, ProgressTrack, RunButton };
