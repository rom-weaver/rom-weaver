import { classifyPatcherInput } from "../../lib/input/input-classification.ts";
import { createTiming, formatTiming } from "../../storage/shared/timing.ts";
import type { ProgressEvent } from "../../types/workflow-runtime-types.ts";
import type { ArchivePathEntry, StagedInputInfo } from "./apply-session-types.ts";
import { getBinarySourceFileName } from "./input-session-helpers.ts";
import type { BinarySource } from "./patcher-form.ts";
import type { RomInputRowState } from "./patcher-ui-state.ts";
import { createInertPatcherUiSessionState } from "./patcher-ui-state.ts";

const createRomInputRow = (
  partial: Omit<Partial<RomInputRowState>, "info"> & {
    id: string;
    order?: number;
    info?: Partial<RomInputRowState["info"]>;
  },
): RomInputRowState => ({
  ...createInertPatcherUiSessionState().romInput,
  ...partial,
  groupId: partial.groupId || "",
  id: partial.id,
  info: {
    archiveName: "",
    checksumsExpanded: true,
    checksumTiming: "",
    crc32: "",
    fileName: "",
    md5: "",
    romInfo: "",
    sha1: "",
    validationPhase: "idle",
    ...(partial.info || {}),
  },
  kind: partial.kind || "",
  order: partial.order ?? 0,
});

const sortRomInputs = (rows: RomInputRowState[]) =>
  rows.toSorted((left, right) => left.order - right.order || left.id.localeCompare(right.id));

const getProgressDetails = (event: ProgressEvent): Record<string, unknown> =>
  event.details && typeof event.details === "object" && !Array.isArray(event.details)
    ? (event.details as Record<string, unknown>)
    : {};

const getArchivePathEntriesFromProgressDetails = (details: Record<string, unknown>): ArchivePathEntry[] => {
  const parentCompressions = Array.isArray(details.parentCompressions) ? details.parentCompressions : [];
  return parentCompressions
    .map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {}))
    .sort((left, right) => Number(left.depth || 0) - Number(right.depth || 0))
    .map((entry) => ({
      decompressionTimeMs:
        typeof entry.decompressionTimeMs === "number" && Number.isFinite(entry.decompressionTimeMs)
          ? entry.decompressionTimeMs
          : undefined,
      fileName: typeof entry.fileName === "string" ? entry.fileName : "",
      kind: typeof entry.kind === "string" ? entry.kind : undefined,
      outputSize:
        typeof entry.outputSize === "number" && Number.isFinite(entry.outputSize) ? entry.outputSize : undefined,
      sourceSize:
        typeof entry.sourceSize === "number" && Number.isFinite(entry.sourceSize) ? entry.sourceSize : undefined,
    }))
    .filter((entry) => !!entry.fileName);
};

const getArchiveNameFromProgressDetails = (details: Record<string, unknown>) => {
  const archivePathEntries = getArchivePathEntriesFromProgressDetails(details);
  return archivePathEntries.map((entry) => entry.fileName).join(" > ");
};

// The early `extract --probe` manifest (Rust `stage: "probe-manifest"`) carries the
// detected platform/disc-format before extraction finishes, so the ROM type tag can
// light up on the loading card mid-extract instead of only at checksum time. Snake-case
// keys come straight from the Rust `RomIdentity` serialization.
const getRomTypeFromProgressDetails = (details: Record<string, unknown>): StagedInputInfo["romType"] => {
  const manifest = details.probe_manifest;
  if (!manifest || typeof manifest !== "object") return undefined;
  const record = manifest as Record<string, unknown>;
  const platform = typeof record.platform === "string" ? record.platform : undefined;
  const discFormat = typeof record.disc_format === "string" ? record.disc_format : undefined;
  return platform || discFormat ? { discFormat, platform } : undefined;
};

const getProgressStagedInputInfo = (event: ProgressEvent): StagedInputInfo => {
  const details = getProgressDetails(event);
  const fileName = typeof details.fileName === "string" ? details.fileName : "";
  const progressStage = typeof details.stage === "string" ? details.stage : event.stage;
  const isPreparedFileName =
    details.wasDecompressed === true || progressStage === "checksum" || progressStage === "decompress";
  return {
    archiveName: getArchiveNameFromProgressDetails(details),
    chdMode: typeof details.chdMode === "string" ? details.chdMode : undefined,
    decompressionTimeMs: typeof details.decompressionTimeMs === "number" ? details.decompressionTimeMs : undefined,
    fileName: getInputDisplayFileName(fileName, isPreparedFileName),
    id: typeof details.sourceId === "string" ? details.sourceId : "",
    order: typeof details.order === "number" ? details.order : undefined,
    parentCompressions: getArchivePathEntriesFromProgressDetails(details),
    romType: getRomTypeFromProgressDetails(details),
    size: typeof details.size === "number" ? details.size : undefined,
    sourceSize: typeof details.sourceSize === "number" ? details.sourceSize : undefined,
    wasDecompressed: typeof details.wasDecompressed === "boolean" ? details.wasDecompressed : undefined,
  };
};

const getChecksumProgressInfoPatch = (
  details: Record<string, unknown>,
): Omit<Partial<RomInputRowState>, "info"> & { info?: Partial<RomInputRowState["info"]> } => {
  const isChecksum = details.stage === "checksum";
  const info: Partial<RomInputRowState["info"]> = {
    crc32: isChecksum ? "" : undefined,
    md5: isChecksum ? "" : undefined,
    sha1: isChecksum ? "" : undefined,
    validationPhase: isChecksum ? "checksum" : "idle",
  };
  return {
    disabled: true,
    info,
    loading: true,
  };
};

const isCompressedInputFileName = (fileName: string) => {
  if (!fileName) return false;
  try {
    return classifyPatcherInput({ fileName }).kind === "compression";
  } catch (_error) {
    return false;
  }
};

const getInputDisplayFileName = (fileName: string | undefined, prepared = false) => {
  const normalized = String(fileName || "");
  if (!normalized) return "";
  return !prepared && isCompressedInputFileName(normalized) ? "" : normalized;
};

const getPendingInputDisplayFileName = (input: BinarySource, fallback: string) =>
  getInputDisplayFileName(getBinarySourceFileName(input, fallback));

const archiveNameIncludesFileName = (archiveName: string, fileName: string) =>
  archiveName
    .split(" > ")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .includes(fileName);

const resolveMergedRomFileName = ({
  archiveName,
  existingFileName,
  nextFileName,
}: {
  archiveName: string;
  existingFileName: string;
  nextFileName: string | undefined;
}) => {
  if (!nextFileName) return existingFileName;
  if (
    existingFileName &&
    existingFileName !== nextFileName &&
    archiveNameIncludesFileName(archiveName, nextFileName) &&
    !archiveNameIncludesFileName(archiveName, existingFileName)
  ) {
    return existingFileName;
  }
  return nextFileName;
};

const sumStagedInfoSize = (infos: StagedInputInfo[], key: "size" | "sourceSize") => {
  let total = 0;
  let found = false;
  for (const info of infos) {
    const value = info[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      total += value;
      found = true;
    }
  }
  return found ? total : null;
};

const getStagedDecompressionTimeMs = (infos: StagedInputInfo[]) => {
  if (!infos.some((info) => info.wasDecompressed)) return null;
  let total = 0;
  let found = false;
  for (const info of infos) {
    const elapsedMs = info.decompressionTimeMs;
    if (typeof elapsedMs === "number" && Number.isFinite(elapsedMs)) {
      total += elapsedMs;
      found = true;
    }
  }
  return found ? total : null;
};

const formatOperationTiming = (label: string, elapsedMs: number | null) => {
  if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs) || elapsedMs < 0) return "";
  return `${label}: ${formatTiming(createTiming(elapsedMs))}`;
};

export {
  createRomInputRow,
  formatOperationTiming,
  getChecksumProgressInfoPatch,
  getPendingInputDisplayFileName,
  getProgressDetails,
  getProgressStagedInputInfo,
  getStagedDecompressionTimeMs,
  resolveMergedRomFileName,
  sortRomInputs,
  sumStagedInfoSize,
};
