import type { ComponentChildren } from "preact";

/**
 * Keep the resolved input-card structure mounted during staging so progress,
 * shimmer rows, and final checks do not shift the surrounding layout.
 */

/** Minimal shape of the converted workflow progress props the staging UI reads. */
type StageProgress = { label?: ComponentChildren; percent?: number | null } | null | undefined;

/**
 * Use the runtime's stage flag, not progress-label text, to distinguish
 * "<verb>…" from "Extracting & <verb>…". Labels vary across startup/finalize and
 * formats, so text sniffing hid combined phases.
 */
const stageStatusLabel = (verb: string, extracting: boolean): string =>
  extracting ? `Extracting & ${verb}…` : `${verb}…`;

/** Numeric percent from converted progress props, or null when indeterminate. */
const stagePercent = (progress: StageProgress): number | null =>
  typeof progress?.percent === "number" ? progress.percent : null;

/**
 * Top-bar value during staging: a determinate width when the percent is known,
 * `"indeterminate"` (an animated sliding bar) when it isn't, and `null` once
 * finished - the bar is removed on the resolved card, leaving only the
 * platform/format tag in the meta line.
 */
const stageBarValue = (staging: boolean, percent: number | null): number | "indeterminate" | null =>
  staging ? (percent ?? "indeterminate") : null;

/**
 * Status that rides the card's meta line during staging, sized to match the size /
 * tag chips (`.stage-status`). It carries the id the browser staging gate
 * (`hasStagingProgress()`) detects, so an in-flight stage is still observable.
 */
const StageStatus = ({ id, label, percent }: { id: string; label: string; percent: number | null }) => (
  <span className="stage-status" id={id}>
    {label}
    {percent === null ? null : <span className="pct">{Math.round(percent)}%</span>}
  </span>
);

export { StageStatus, stageBarValue, stagePercent, stageStatusLabel };
