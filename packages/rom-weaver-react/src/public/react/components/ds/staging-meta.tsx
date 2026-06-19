import type { ReactNode } from "react";

/**
 * Shared staging-card helpers for the input cards (ROM + patch). During staging
 * the resolved card structure stays mounted — a determinate bar on the card's top
 * edge ({@link "./file-card.tsx" FileCard} `stageBar`) plus a status in the meta
 * line carry progress, while the Checks drawer reserves its rows as shimmer
 * placeholders — so nothing below the card moves when the result lands.
 */

/** Minimal shape of the converted workflow progress props the staging UI reads. */
type StageProgress = { label?: ReactNode; percent?: number | null } | null | undefined;

/**
 * Phase-aware staging label: "<verb>…" normally, "Extracting & <verb>…" while the
 * runtime's extract stage is in flight (it hashes/validates during extraction, so
 * both verbs apply). `verb` is "Checksumming" for ROM inputs, "Validating" for
 * patches — the runtime labels the extract stage "Extracting <name>".
 */
const stageStatusLabel = (progress: StageProgress, verb: string): string =>
  /extract/i.test(String(progress?.label ?? "")) ? `Extracting & ${verb}…` : `${verb}…`;

/** Numeric percent from converted progress props, or null when indeterminate. */
const stagePercent = (progress: StageProgress): number | null =>
  typeof progress?.percent === "number" ? progress.percent : null;

/**
 * Top-bar value during staging: a determinate width when the percent is known,
 * `"indeterminate"` (an animated sliding bar) when it isn't, and `null` once
 * finished — the bar is removed on the resolved card, leaving only the
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
