/** Whether a trim run removes trailing padding or restores it. */
type TrimMode = "trim" | "restore";

const TRIMMED_MARKER = /\s*\(trimmed\)$/i;
const RESTORED_MARKER = /\(restored\)$/i;

/**
 * Mark an output stem with its operation. A trim always ends in `(trimmed)`; a restore drops that
 * marker and ends in `(restored)` only when the result would otherwise reuse the input's stem.
 */
const markTrimOutputStem = (stem: string, sourceStem: string, mode: TrimMode) => {
  const base = stem.trim();
  if (mode === "trim") return TRIMMED_MARKER.test(base) ? base : `${base || "trimmed"} (trimmed)`;
  const restored = base.replace(TRIMMED_MARKER, "").trim();
  if (restored && restored.toLowerCase() !== sourceStem.trim().toLowerCase()) return restored;
  return RESTORED_MARKER.test(restored) ? restored : `${restored || "restored"} (restored)`;
};

export { markTrimOutputStem, type TrimMode };
