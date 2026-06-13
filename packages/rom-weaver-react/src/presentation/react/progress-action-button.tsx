import X from "lucide-react/dist/esm/icons/x.js";
import type { ReactNode } from "react";
import type { createProgressViewModel } from "../workflow-presentation.ts";
import { clampProgressPercent, normalizeProgressDisplayPercent } from "../workflow-presentation.ts";

const THREAD_LABEL_SEGMENTS_REGEX = /^(.*?)(?:\s+(?:with|-)\s+(\d+\s+threads?))(\.\.\.)?$/i;
const TRAILING_ELLIPSIS_REGEX = /\s*\.\.\.$/;
const DOWNLOAD_LABEL_REGEX = /download/i;

const join = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ");

type ProgressViewModel = ReturnType<typeof createProgressViewModel>;

type ProgressActionButtonProps = {
  label: string;
  disabled: boolean;
  onClick: () => void;
  progress: ProgressViewModel | null;
  id?: string;
  title?: string;
  icon?: ReactNode;
  loading?: boolean;
  onCancel?: () => void;
  cancelLabel?: string;
  progressId?: string;
};

const formatProgressLabelParts = (progress: ProgressViewModel) => {
  const percent = normalizeProgressDisplayPercent(progress.percent);
  const timingText = progress.timingText ? ` ${progress.timingText}` : "";
  const label = `${progress.label || progress.message}${timingText}`;
  const threadMatch = label.match(THREAD_LABEL_SEGMENTS_REGEX);
  const percentText = typeof percent === "number" ? `${percent}%` : "";
  if (!threadMatch) {
    return {
      percentText,
      taskText: label.replace(TRAILING_ELLIPSIS_REGEX, "").trim(),
      threadsText: "",
    };
  }
  return {
    percentText,
    taskText: String(threadMatch[1] || label)
      .replace(TRAILING_ELLIPSIS_REGEX, "")
      .trim(),
    threadsText: threadMatch[2] || "",
  };
};

function ProgressActionButton({
  label,
  disabled,
  onClick,
  progress,
  id,
  title,
  icon,
  loading,
  onCancel,
  cancelLabel = "Cancel operation",
  progressId,
}: ProgressActionButtonProps) {
  const progressLabelParts = progress ? formatProgressLabelParts(progress) : null;
  const hasNumericPercent =
    !!progress &&
    ((typeof progress.visualPercent === "number" && Number.isFinite(progress.visualPercent)) ||
      (typeof progress.percent === "number" && Number.isFinite(progress.percent)));
  // No known percentage → indeterminate (animated sliver), never a static partial bar.
  const isIndeterminate = Boolean(progress) && !hasNumericPercent;
  const determinatePercent =
    progress && typeof progress.visualPercent === "number" && Number.isFinite(progress.visualPercent)
      ? Math.max(0, Math.min(100, progress.visualPercent))
      : progress
        ? clampProgressPercent(progress.percent) || 0
        : 0;
  const isDownload = !progress && DOWNLOAD_LABEL_REGEX.test(label);

  // While running, the button is replaced by the loom live-run panel — the
  // borderless instrument row that spans the output card's content width.
  if (progress) {
    return (
      <div className="prog-panel runprog fileprog rom-weaver-has-progress" id={progressId} title={progress.message}>
        <div className="prog run-prog">
          <div className="lab">
            <span className="what run-stage-label">{progressLabelParts?.taskText || progress.message}</span>
          </div>
          <div aria-hidden="true" className={join("meter track live", isIndeterminate && "indet")}>
            <div
              className="fill bar run-fill"
              style={{ width: isIndeterminate ? undefined : `${determinatePercent}%` }}
            />
          </div>
          <div className="sub mono">
            <span>{progressLabelParts?.threadsText || ""}</span>
            <span className="run-pct">{progressLabelParts?.percentText || "—"}</span>
          </div>
        </div>
        {onCancel ? (
          <div className="prog-actions">
            <button
              aria-label={cancelLabel}
              className="cancel run-cancel progress-cancel"
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
  }

  return (
    <button
      className={join("btn primary run", isDownload && "download-btn dl")}
      disabled={disabled}
      id={id}
      onClick={onClick}
      title={title}
      type="button"
    >
      {loading ? null : icon}
      {label}
    </button>
  );
}

export { ProgressActionButton, type ProgressViewModel };
