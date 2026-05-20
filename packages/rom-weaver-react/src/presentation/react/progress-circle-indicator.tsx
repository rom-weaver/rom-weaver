import { cx } from "../tailwind-classes.ts";

type ProgressCircleIndicatorProps = {
  animateWhenPercentMissing?: boolean;
  containerClassName: string;
  indeterminate?: boolean;
  normalizedPercent: number | null;
  percentText: string;
  radius?: number;
  spinClassName: string;
  svgClassName: string;
  textClassName?: string;
};

const DEFAULT_RADIUS = 15;
const DEFAULT_STROKE_WIDTH = 3;

function ProgressCircleIndicator({
  animateWhenPercentMissing = false,
  containerClassName,
  indeterminate = false,
  normalizedPercent,
  percentText,
  radius = DEFAULT_RADIUS,
  spinClassName,
  svgClassName,
  textClassName = "text-[10px]",
}: ProgressCircleIndicatorProps) {
  const shouldAnimate = indeterminate || (animateWhenPercentMissing && (!percentText || percentText === "--"));
  const circumference = 2 * Math.PI * radius;
  const isDeterminate = typeof normalizedPercent === "number";
  const isComplete = isDeterminate && normalizedPercent >= 100;
  const dashOffset = isDeterminate ? circumference - (normalizedPercent / 100) * circumference : circumference * 0.64;

  return (
    <span
      className={cx(
        "relative flex flex-none items-center justify-center rounded-full border border-[var(--rom-weaver-color-border)] bg-[var(--rom-weaver-color-surface)]",
        containerClassName,
      )}
    >
      <svg aria-hidden="true" className={cx(svgClassName, shouldAnimate && spinClassName)} viewBox="0 0 36 36">
        <circle
          cx="18"
          cy="18"
          fill="none"
          r={radius}
          stroke="oklch(0.76 0.03 301 / 0.6)"
          strokeWidth={DEFAULT_STROKE_WIDTH}
        />
        <circle
          cx="18"
          cy="18"
          fill="none"
          r={radius}
          stroke="var(--rom-weaver-color-primary)"
          strokeDasharray={
            shouldAnimate ? `${circumference * 0.35} ${circumference}` : isComplete ? undefined : `${circumference}`
          }
          strokeDashoffset={isComplete ? undefined : dashOffset}
          strokeLinecap={isComplete ? "butt" : "round"}
          strokeWidth={DEFAULT_STROKE_WIDTH}
          style={{
            transition: shouldAnimate ? undefined : "stroke-dashoffset 0.3s cubic-bezier(0.22,1,0.36,1)",
          }}
        />
      </svg>
      <span
        className={cx(
          "absolute inset-0 flex items-center justify-center font-bold tabular-nums text-[var(--rom-weaver-color-text)]",
          textClassName,
        )}
      >
        {percentText}
      </span>
    </span>
  );
}

export { ProgressCircleIndicator };
