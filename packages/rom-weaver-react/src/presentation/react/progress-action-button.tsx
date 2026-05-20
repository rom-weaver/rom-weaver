import type { ReactNode } from "react";
import { buttonClasses, cx, progressClasses } from "../tailwind-classes.ts";
import type { createProgressViewModel } from "../workflow-presentation.ts";
import { clampProgressPercent, normalizeProgressDisplayPercent } from "../workflow-presentation.ts";
import { ProgressCircleIndicator } from "./progress-circle-indicator.tsx";

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

const resolveNormalizedProgressPercent = (progress: ProgressViewModel) => {
  const percent =
    typeof progress.visualPercent === "number" && Number.isFinite(progress.visualPercent)
      ? Math.max(0, Math.min(100, progress.visualPercent))
      : clampProgressPercent(progress.percent);
  return typeof percent === "number" ? percent : null;
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
  const normalizedPercent = progress ? resolveNormalizedProgressPercent(progress) : null;

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
          <div className="flex h-full min-w-0 items-center gap-2.5">
            <div className="min-w-0 flex flex-1 flex-col justify-center gap-1">
              <span
                className={cx(
                  "rom-weaver-input-progress-text",
                  progressClasses.text,
                  progressClasses.applyText,
                  "gap-2",
                )}
                title={progress.message}
              >
                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left">
                  {progressLabelParts?.taskText || progress.message}
                </span>
              </span>
            </div>
            <ProgressCircleIndicator
              animateWhenPercentMissing
              containerClassName="h-[40px] w-[40px] shadow-[inset_0_1px_0_oklch(1_0_0_/_0.45)]"
              indeterminate={progress.indeterminate}
              normalizedPercent={normalizedPercent}
              percentText={progressLabelParts?.percentText || (progress.indeterminate ? "..." : "--")}
              radius={16}
              spinClassName="animate-[spin_1.15s_linear_infinite]"
              svgClassName="h-[38px] w-[38px] -rotate-90"
              textClassName="text-[10px]"
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
