import { Check, X } from "lucide-react";
import type { Localizer } from "../../presentation/localization/index.ts";
import { InfoToggle } from "../../presentation/react/info-toggle.tsx";
import { createTiming, formatTiming } from "../../storage/shared/timing.ts";
import type { ParsedBundleChecks } from "../../types/bundle.ts";
import { CHECK_ALGORITHMS, type CHECK_FIELDS, CHECK_LABELS } from "./components/ds/check-fields.ts";
import type { PatchStackItemState } from "./patcher-presentation.ts";
import { useUiLocalizer } from "./settings-context.tsx";

export const TIMING_LABEL = (ms?: number) =>
  typeof ms === "number" && Number.isFinite(ms) ? formatTiming(createTiming(ms)) : "";
export const CHECKSUM_TIMING_LABEL = (timing?: string, prefix = "Checksum") =>
  timing ? `${prefix} ${timing}` : undefined;

const PATCH_INPUT_VERIFICATION_LABELS: Record<string, string> = {
  "in crc32": "CRC32",
  "in md5": "MD5",
  "in min size": "MIN BYTES",
  "in sha-1": "SHA-1",
  "in sha1": "SHA-1",
  "in size": "BYTES",
  "in rom": "ROM",
};

const PATCH_OUTPUT_VERIFICATION_LABELS: Record<string, string> = {
  "out crc32": "CRC32",
  "out md5": "MD5",
  "out sha-1": "SHA-1",
  "out sha1": "SHA-1",
  "out size": "BYTES",
};

const BUNDLE_CHECK_LABELS: Record<string, string> = {
  crc32: CHECK_LABELS.crc32,
  md5: CHECK_LABELS.md5,
  sha1: CHECK_LABELS.sha1,
};

/** Requirement rows this patch will actually verify, per side: embedded/declared
 * hashes, sizes, and free-form validation notes. */
export const getPatchVerificationRows = (item: PatchStackItemState) => {
  const inputRows: Array<{ label: string; value: string }> = [];
  const outputRows: Array<{ label: string; value: string }> = [];
  const xdeltaSizeOnly = item.validationValues.some((entry) => /^in min size=/i.test(entry));
  for (const entry of item.validationValues) {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex === -1) {
      // The generic preflight marker never renders as a per-type row; the drawer-header verdict
      // already covers it.
      if (/preflight|dry-?run/i.test(entry)) continue;
      inputRows.push({ label: "VALIDATION", value: entry });
      continue;
    }
    const rawLabel = entry.slice(0, separatorIndex).trim().toLowerCase();
    const value = entry.slice(separatorIndex + 1).trim();
    if (!value) continue;
    if (xdeltaSizeOnly && (rawLabel === "in min size" || rawLabel === "out size")) continue;
    if (PATCH_INPUT_VERIFICATION_LABELS[rawLabel]) {
      inputRows.push({ label: PATCH_INPUT_VERIFICATION_LABELS[rawLabel], value });
      continue;
    }
    outputRows.push({ label: PATCH_OUTPUT_VERIFICATION_LABELS[rawLabel] || rawLabel.toUpperCase(), value });
  }
  // BYTES pairs with CRC32 on one grid row, so it rides directly after it;
  // with no CRC32 requirement the size row keeps its end-of-list spot.
  const bytesAfterCrc32 = (rows: typeof inputRows) => {
    const bytes = rows.filter((row) => row.label === "BYTES");
    if (!bytes.length) return rows;
    const rest = rows.filter((row) => row.label !== "BYTES");
    const crcIndex = rest.findIndex((row) => row.label === "CRC32");
    if (crcIndex === -1) return [...rest, ...bytes];
    return [...rest.slice(0, crcIndex + 1), ...bytes, ...rest.slice(crcIndex + 1)];
  };
  return { inputRows: bytesAfterCrc32(inputRows), outputRows: bytesAfterCrc32(outputRows) };
};

/* The dry-run's "validation failed: " lead-in duplicates the well's title -
   strip it and re-capitalize what remains so the detail reads as a sentence. */
const toFaultDetail = (message: string, localizer: Localizer): string => {
  const detail = message.replace(/^\s*validation failed:?\s*/i, "").trim();
  if (!detail) return localizer.message("ui.patch.validationMismatch");
  return detail.charAt(0).toUpperCase() + detail.slice(1);
};

/** Failed dry-run verdict: an inset fault well with the verdict, the detail,
 * and what to do next (naming the 0x04 override toggle when it is offered). */
export const PatchFaultWell = ({ message, overrideAvailable }: { message: string; overrideAvailable?: boolean }) => {
  const localizer = useUiLocalizer();
  return (
    <div className="pverdict pfault">
      <div className="pfault-title">
        <X aria-hidden="true" />
        <span>{localizer.message("ui.patch.validationFailed")}</span>
      </div>
      <p className="pfault-detail">{toFaultDetail(message, localizer)}</p>
      <p className="pfault-hint">
        {overrideAvailable
          ? localizer.message("ui.patch.validationMismatchOverride")
          : localizer.message("ui.patch.validationMismatchHint")}
      </p>
    </div>
  );
};

export const PreflightSuccess = () => {
  const localizer = useUiLocalizer();
  return (
    <InfoToggle
      ariaLabel={localizer.message("ui.patch.preflightPassed")}
      className="dry-apply-info"
      icon={<Check aria-hidden="true" />}
      panelClassName="dry-apply-pop"
      portalPanel
      title={localizer.message("ui.patch.preflightPassed")}
    >
      <strong>{localizer.message("ui.patch.preflightPassed")}</strong>
      <p>{localizer.message("ui.patch.preflightVerified")}</p>
      <p>{localizer.message("ui.patch.preflightOutputPending")}</p>
    </InfoToggle>
  );
};

/** Grow a textarea to its content (`field-sizing: content` isn't in every
 * target browser yet); runs on mount and on every input. */
export const autosizeTextarea = (element: HTMLTextAreaElement | null) => {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight + 2}px`;
};

export const getEmbeddedChecks = (item: PatchStackItemState, side: "input" | "output") => {
  const prefix = side === "input" ? "in " : "out ";
  const checks: Partial<Record<(typeof CHECK_FIELDS)[number], string>> = {};
  for (const entry of item.validationValues) {
    const [rawLabel, rawValue] = entry.split("=", 2);
    const label = rawLabel?.trim().toLowerCase();
    const value = rawValue?.trim();
    if (!(label?.startsWith(prefix) && value)) continue;
    const algorithm = label.slice(prefix.length).replace("sha-1", "sha1");
    // exact byte size only - "min size" is a lower bound, not a bytes value
    if (algorithm === "size") {
      checks.bytes = value;
      continue;
    }
    if (CHECK_ALGORITHMS.includes(algorithm as (typeof CHECK_ALGORITHMS)[number])) {
      checks[algorithm as (typeof CHECK_ALGORITHMS)[number]] = value;
    }
  }
  return checks;
};

export const bundleCheckRows = (checks: ParsedBundleChecks | undefined) => {
  const rows: Array<{ label: string; value: string }> = [];
  for (const [algorithm, value] of Object.entries(checks?.checksums || {})) {
    const normalized = algorithm.toLowerCase().replace("sha-1", "sha1");
    const label = BUNDLE_CHECK_LABELS[normalized];
    if (label && value.trim()) rows.push({ label, value: value.trim() });
  }
  if (typeof checks?.size === "number") rows.push({ label: "BYTES", value: String(checks.size) });
  return rows;
};
