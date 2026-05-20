const POSIX_DIRECTORY_PREFIX_REGEX = /^.*\//;
const TRAILING_ELLIPSIS_REGEX = /(?:\s*\.\.\.)+$/;

type FileNameValue = string | number | boolean | null | undefined;
type NumericValue = string | number | null | undefined;
type ProgressRecord = {
  label?: string;
  message?: string;
  percent?: NumericValue;
  loaded?: NumericValue;
  total?: NumericValue;
};
type ProgressInput = NumericValue | ProgressRecord | null | undefined;
type ProgressEventLike = {
  label: string;
  percent: number | null;
};
type ParsedPatchLike = {
  fileName?: string;
  _originalPatchFile?: {
    fileName?: string;
  };
};
type PatchSequenceProgress = {
  reportPatchStart: (patchIndex: number) => void;
  createPatchProgress: (patchIndex: number) => ((progress: ProgressInput, total: NumericValue) => void) | null;
};

const FILE_EXTENSION_PATTERN = /\.([^./\\\s]+)$/;

const getFileBaseName = (fileName: FileNameValue): string =>
  String(fileName || "")
    .replace(/\\/g, "/")
    .replace(POSIX_DIRECTORY_PREFIX_REGEX, "");
const getFileExtension = (fileName: FileNameValue): string => {
  const match = getFileBaseName(fileName).match(FILE_EXTENSION_PATTERN);
  return match?.[1] ? match[1] : "";
};
const escapeRegExp = (str: FileNameValue): string => String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const getFileNameWithoutExtension = (fileName: FileNameValue): string => {
  const baseName = getFileBaseName(fileName);
  const extension = getFileExtension(baseName);
  return extension ? baseName.replace(new RegExp(`\\.${escapeRegExp(extension)}$`, "i"), "") : baseName;
};
const sanitizeFileNamePart = (fileNamePart: FileNameValue, fallback: FileNameValue): string => {
  const sanitized = String(fileNamePart || "")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .split("")
    .map((character) => (character.charCodeAt(0) <= 0x1f ? " " : character))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized || String(fallback || "patched");
};
const stripTrailingEllipsis = (label: FileNameValue): string =>
  String(label || "")
    .trim()
    .replace(TRAILING_ELLIPSIS_REGEX, "");
const getDefaultApplyProgressLabel = (patchIndex: number, totalPatches: number) =>
  totalPatches > 1 ? `Applying patch ${patchIndex + 1} of ${totalPatches}...` : "Applying patch...";
const normalizeApplyProgressPercent = (value: NumericValue) => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.min(100, value));
  if (typeof value === "string" && value.trim()) {
    const parsed = parseFloat(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.min(100, parsed));
  }
  return null;
};
const normalizeFiniteNumber = (value: NumericValue) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};
const normalizeApplyProgressEvent = (progress: ProgressInput, total: NumericValue, fallbackLabel: string) => {
  if (typeof progress === "number" && Number.isFinite(progress)) {
    const normalizedTotal = normalizeFiniteNumber(total);
    return {
      label: fallbackLabel,
      percent:
        normalizedTotal && normalizedTotal > 0 ? Math.max(0, Math.min(100, (progress / normalizedTotal) * 100)) : null,
    };
  }
  if (progress && typeof progress === "object") {
    const progressRecord = progress as ProgressRecord;
    const label =
      typeof progressRecord.label === "string" && progressRecord.label
        ? progressRecord.label
        : (() => {
            if (typeof progressRecord.message === "string" && progressRecord.message) {
              return progressRecord.message;
            }
            return fallbackLabel;
          })();
    const percentFromFields =
      normalizeApplyProgressPercent(progressRecord.percent) ??
      (typeof progressRecord.loaded === "number" && typeof progressRecord.total === "number" && progressRecord.total > 0
        ? Math.max(0, Math.min(100, (progressRecord.loaded / progressRecord.total) * 100))
        : null);
    return {
      label,
      percent: percentFromFields,
    };
  }
  return {
    label: fallbackLabel,
    percent: null,
  };
};
const createPatchSequenceProgress = (
  patches: ParsedPatchLike[],
  options: { onProgress?: ((progress: ProgressEventLike) => void) | null },
): PatchSequenceProgress => {
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  if (!onProgress) {
    return {
      createPatchProgress: () => null,
      reportPatchStart: () => undefined,
    };
  }
  const totalPatches = patches.length || 1;
  let lastDeterminatePercent = -1;
  let lastLabel = "";
  let lastPercent: number | null = null;
  const emitProgress = (patchIndex: number, progress?: ProgressInput, total?: NumericValue) => {
    const fallbackLabel = getDefaultApplyProgressLabel(patchIndex, totalPatches);
    const normalized = normalizeApplyProgressEvent(progress, total, fallbackLabel);
    const rawLabel = normalized.label || fallbackLabel;
    const label =
      totalPatches > 1 && rawLabel !== fallbackLabel
        ? `${stripTrailingEllipsis(rawLabel)} (${patchIndex + 1}/${totalPatches})`
        : rawLabel;
    let percent = null;
    if (normalized.percent !== null) {
      const overallPercent = ((patchIndex + normalized.percent / 100) / totalPatches) * 100;
      lastDeterminatePercent = Math.max(lastDeterminatePercent, overallPercent);
      percent = Math.max(0, Math.min(100, lastDeterminatePercent));
    }
    if (label === lastLabel && percent === lastPercent) return;
    lastLabel = label;
    lastPercent = percent;
    onProgress({
      label,
      percent,
    });
  };
  return {
    createPatchProgress: (patchIndex: number) => (progress: ProgressInput, total: NumericValue) =>
      emitProgress(patchIndex, progress, total),
    reportPatchStart: (patchIndex: number) => emitProgress(patchIndex, undefined, undefined),
  };
};

export type {
  FileNameValue,
  NumericValue,
  ParsedPatchLike,
  PatchSequenceProgress,
  ProgressEventLike,
  ProgressInput,
  ProgressRecord,
};
export {
  createPatchSequenceProgress,
  escapeRegExp,
  getDefaultApplyProgressLabel,
  getFileBaseName,
  getFileExtension,
  getFileNameWithoutExtension,
  normalizeApplyProgressEvent,
  normalizeApplyProgressPercent,
  normalizeFiniteNumber,
  sanitizeFileNamePart,
  stripTrailingEllipsis,
};
