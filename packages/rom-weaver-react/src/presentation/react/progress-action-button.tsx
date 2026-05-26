import type { ReactNode } from "react";
import { buttonClasses, cx, progressClasses } from "../tailwind-classes.ts";
import type { createProgressViewModel } from "../workflow-presentation.ts";
import { clampProgressPercent, normalizeProgressDisplayPercent } from "../workflow-presentation.ts";

const THREAD_LABEL_SEGMENTS_REGEX = /^(.*?)(?:\s+(?:with|-)\s+(\d+\s+threads?))(\.\.\.)?$/i;
const TRAILING_ELLIPSIS_REGEX = /\s*\.\.\.$/;

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
    };
  }
  return {
    percentText,
    taskText: `${String(threadMatch[1] || label)
      .replace(TRAILING_ELLIPSIS_REGEX, "")
      .trim()} ${threadMatch[2] || ""}`.trim(),
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
  progressId,
}: ProgressActionButtonProps) {
  const progressLabelParts = progress ? formatProgressLabelParts(progress) : null;
  const progressScale =
    progress && typeof progress.visualPercent === "number" && Number.isFinite(progress.visualPercent)
      ? `scaleX(${Math.max(0, Math.min(100, progress.visualPercent)) / 100})`
      : progress
        ? `scaleX(${(clampProgressPercent(progress.percent) || 0) / 100})`
        : null;

  return (
    <button
      className={cx(
        buttonClasses.primary,
        buttonClasses.apply,
        progress && "rom-weaver-has-progress",
        progress && buttonClasses.applyProgress,
      )}
      disabled={disabled}
      id={id}
      onClick={onClick}
      title={title}
      type="button"
    >
      {progress ? (
        <div
          className={cx("rom-weaver-input-progress", progressClasses.container, progressClasses.applyContainer)}
          id={progressId}
        >
          <span
            className={cx("rom-weaver-input-progress-text", progressClasses.text, progressClasses.applyText, "gap-2")}
            title={progress.message}
          >
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left">
              {progressLabelParts?.taskText || progress.message}
            </span>
            {progressLabelParts?.percentText ? (
              <span className="ml-2 flex-none text-right tabular-nums">{progressLabelParts.percentText}</span>
            ) : null}
          </span>
          <div className={cx("rom-weaver-input-progress-track", progressClasses.track, progressClasses.applyTrack)}>
            <div
              className={cx(
                "rom-weaver-input-progress-bar",
                progressClasses.bar,
                progressClasses.applyBar,
                progress.percent === null && progressClasses.barIndeterminate,
              )}
              style={{
                transform: progress.percent === null ? undefined : progressScale || undefined,
              }}
            />
          </div>
        </div>
      ) : (
        <>
          {loading ? null : icon}
          {label}
        </>
      )}
    </button>
  );
}

export { ProgressActionButton, type ProgressViewModel };
