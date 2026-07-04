import { appendFileNameExtension } from "../../lib/input/path-utils.ts";
import type { BrowserSaveDestination, RuntimePatchCreateFormatCandidates } from "../../platform/browser/browser-api.ts";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import type { CreateWorkflowSourceState } from "../../types/create-workflow.ts";
import { ARCHIVE_FILE_EXTENSIONS, ROM_FILE_EXTENSIONS } from "./file-classification.ts";
import { toStagedInputInfo } from "./workflow-adapters.ts";
import { formatChecksumTiming } from "./workflow-form-utils.ts";
import type { WorkflowFormProgressState } from "./workflow-run-hooks.ts";

/**
 * Pure output/source presentation helpers for the create-patch form, extracted
 * from `CreatePatchForm`. These derive the completed-output download face
 * (format / size / compression-ratio label), the execution output name, the
 * displayed source-info projections, and the static hero/support lists — all
 * state-free derivations the form composes into its view model.
 */

const resolveCreateExecutionOutputName = (outputName: string, patchType: string) => {
  const normalizedOutputName = outputName.trim();
  if (!normalizedOutputName) return normalizedOutputName;
  // Ensure the name ends with the real patch extension, not just any dotted
  // segment: a version like "Game 2.2" reads as extension ".2" to a generic
  // check, so the format extension never gets appended and Rust's checksum-name
  // embed jams the crc into the version ("Game 2 [crc32:…].2") — an unreadable
  // output name. We know the target extension here, so key off it directly.
  const extension = (patchType || "bps").toLowerCase();
  if (normalizedOutputName.toLowerCase().endsWith(`.${extension}`)) return normalizedOutputName;
  return appendFileNameExtension(normalizedOutputName, extension);
};

const getFileExtensionLabel = (fileName: string) => {
  const extension = fileName.trim().match(/(\.[^./\\]+)$/)?.[1];
  return extension || fileName;
};

// Below this raw size a percentage is noise (tiny patches read as 44522%),
// so the ratio is suppressed and the byte size stands on its own.
const MIN_COMPRESSION_RATIO_RAW_BYTES = 100 * 1024;

const getCompressionRatioLabel = (
  compression: "7z" | "none" | "zip",
  outputSize?: number | null,
  rawSize?: number | null,
) => {
  if (compression === "none") return undefined;
  if (
    typeof outputSize !== "number" ||
    !Number.isFinite(outputSize) ||
    typeof rawSize !== "number" ||
    !Number.isFinite(rawSize) ||
    rawSize < MIN_COMPRESSION_RATIO_RAW_BYTES
  ) {
    return undefined;
  }
  return `${Math.round((outputSize / rawSize) * 100)}%`;
};

const getCompletedDownloadMeta = ({
  compression,
  fileName,
  patchType,
  rawSize,
  size,
}: {
  compression: "7z" | "none" | "zip";
  fileName: string;
  patchType: string;
  rawSize?: number | null;
  size?: number | null;
}) => ({
  // format-only face — the filename already fills the output field above
  format: `Patch .${patchType || getFileExtensionLabel(fileName).replace(/^\./, "") || "patch"}`,
  ratio: getCompressionRatioLabel(compression, size, rawSize),
  size: typeof size === "number" && Number.isFinite(size) ? formatByteSize(size) : undefined,
});

type CreateDisplaySourceState = CreateWorkflowSourceState;
type CreatePatchFormatCandidateState = RuntimePatchCreateFormatCandidates & {
  key: string;
};
type CompletedCreateOutput = {
  compression: "7z" | "none" | "zip";
  compressionTimeMs?: number;
  createTimeMs?: number;
  fileName: string;
  patchType: string;
  rawSize?: number;
  saveAs: (destination?: BrowserSaveDestination) => Promise<void>;
  size?: number;
};
type CreateMessagePlacement = "modified" | "original" | "output";

const getDisplaySourceInfo = (source: CreateDisplaySourceState | null | undefined, fallback: string) =>
  toStagedInputInfo(source, fallback);

const getDisplaySourceChecksums = (source: CreateDisplaySourceState | null | undefined) =>
  (source as (CreateDisplaySourceState & { checksums?: Record<string, string> }) | null | undefined)?.checksums;

const getDisplaySourceChecksumTiming = (source: CreateDisplaySourceState | null | undefined) =>
  formatChecksumTiming(
    (source as (CreateDisplaySourceState & { checksumTimeMs?: number }) | null | undefined)?.checksumTimeMs,
  );

/** Format pills under the 0x01 hero — mirrors the loom prototype's create list. */
const CREATE_HERO_FORMATS = ["sfc", "gba", "iso", "bin", "zip", "7z", "chd", "rvz"] as const;

/** Full registry support, listed in the 0x01 info popover. */
const CREATE_SUPPORTED_FILES = [
  { extensions: ROM_FILE_EXTENSIONS, label: "ROMs" },
  { extensions: ARCHIVE_FILE_EXTENSIONS, label: "Archives & containers" },
] as const;

const getChecksumTimingLabel = (timing: string) => (timing ? `Checksum ${timing}` : "");
const isChecksumProgress = (progress: WorkflowFormProgressState | null) =>
  !!progress && /checksum/i.test(`${progress.label} ${progress.message}`);

export {
  type CompletedCreateOutput,
  CREATE_HERO_FORMATS,
  CREATE_SUPPORTED_FILES,
  type CreateDisplaySourceState,
  type CreateMessagePlacement,
  type CreatePatchFormatCandidateState,
  getChecksumTimingLabel,
  getCompletedDownloadMeta,
  getDisplaySourceChecksums,
  getDisplaySourceChecksumTiming,
  getDisplaySourceInfo,
  isChecksumProgress,
  resolveCreateExecutionOutputName,
};
