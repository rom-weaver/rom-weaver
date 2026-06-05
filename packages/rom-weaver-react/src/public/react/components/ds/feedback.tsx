import CircleX from "lucide-react/dist/esm/icons/circle-x.js";
import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert.js";
import X from "lucide-react/dist/esm/icons/x.js";
import type { ReactNode } from "react";

/**
 * Design-system feedback primitives (notices, progress bars, the run/download
 * button). Pure presentational components used by every workflow so progress
 * and status rendering is never duplicated. Styling comes from the semantic
 * classes in design-system.css.
 */

const join = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ");

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
      <span className="notice-copy">{children}</span>
      {onDismiss ? (
        <button aria-label={dismissLabel} className="notice-x" onClick={onDismiss} title={dismissLabel} type="button">
          <X aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
};

/**
 * Thin progress track + bar. Determinate when `percent` is a number,
 * indeterminate when `indeterminate` is set (a sliver slides across).
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
  const width =
    typeof percent === "number" && Number.isFinite(percent) ? `${Math.max(0, Math.min(100, percent))}%` : undefined;
  // No usable percent → animate (indeterminate sliver) rather than fall back to the static default bar width.
  const isIndeterminate = indeterminate || width === undefined;
  return (
    <div className={join("track", isIndeterminate && "indet", className)}>
      <div className="bar" style={isIndeterminate ? undefined : { width }} />
    </div>
  );
};

/**
 * Labeled progress line: a caption + value above a {@link ProgressTrack}.
 * `value` is the trailing readout (e.g. "64%" or "working").
 */
const InlineProgress = ({
  label,
  value,
  percent,
  indeterminate,
  tight,
  id,
}: {
  label: ReactNode;
  value?: ReactNode;
  percent?: number | null;
  indeterminate?: boolean;
  tight?: boolean;
  id?: string;
}) => (
  <div className={join("iprog", tight && "tight")} id={id}>
    <div className="lab">
      <span>{label}</span>
      {value ? <span className="v">{value}</span> : null}
    </div>
    <ProgressTrack indeterminate={indeterminate} percent={percent} />
  </div>
);

type FileProgressProps = Parameters<typeof InlineProgress>[0];

/** {@link InlineProgress} wrapped in a contained card, for in-row file work. */
const FileProgress = (props: FileProgressProps) => (
  <div className="fileprog">
    <InlineProgress {...props} />
  </div>
);

type DownloadMeta = { format?: string; name?: string; ratio?: string; savedSize?: string; size?: string };

/**
 * The primary action button. Renders the uppercase action by default, or a
 * normal-case download summary (format · size) when `download` is provided.
 */
const RunButton = ({
  onClick,
  disabled,
  icon,
  children,
  download,
  id,
  type = "button",
}: {
  onClick?: () => void;
  disabled?: boolean;
  icon?: ReactNode;
  children?: ReactNode;
  download?: DownloadMeta;
  id?: string;
  type?: "button" | "submit";
}) => (
  <button className={join("run", download && "dl")} disabled={disabled} id={id} onClick={onClick} type={type}>
    {icon}
    {download ? (
      <>
        <span className="sr-only">Download </span>
        {download.format ? <span className="dl-fmt">{download.format}</span> : null}
        {download.name ? <span className="dl-name">{download.name}</span> : null}
        {download.size ? (
          <span className="dl-sz">
            &middot; {download.size}
            {download.savedSize ? <> &middot; saved {download.savedSize}</> : null}
            {download.ratio ? <> &middot; {download.ratio}</> : null}
          </span>
        ) : null}
      </>
    ) : (
      children
    )}
  </button>
);

export {
  type DownloadMeta,
  FileProgress,
  type FileProgressProps,
  InlineProgress,
  Notice,
  type NoticeLevel,
  ProgressTrack,
  RunButton,
};
