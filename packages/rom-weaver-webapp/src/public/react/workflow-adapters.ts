import { clampProgressPercent, normalizeProgressDisplayPercent } from "../../presentation/workflow-presentation.ts";
import type { ApplyWorkflowInputState, ApplyWorkflowPatchState } from "../../types/apply-workflow.ts";
import type { CreateWorkflowSourceState } from "../../types/create-workflow.ts";
import type { ProgressEvent } from "../../types/workflow-runtime-types.ts";
import type { BinarySource } from "./patcher-form.ts";

const CREATE_OUTPUT_EXTENSION_REGEX = /\.[^.]*$/;

const getReactBinarySourceFileName = (source: BinarySource | null | undefined, fallback: string) => {
  if (!source) return "";
  if (source instanceof File && source.name) return source.name;
  if ("name" in source && typeof source.name === "string" && source.name) return source.name;
  return fallback;
};

const getDefaultCreateOutputName = (original: BinarySource | null | undefined) => {
  const originalName = getReactBinarySourceFileName(original, "");
  return originalName.replace(CREATE_OUTPUT_EXTENSION_REGEX, "");
};

const getReactProgressStage = (event: { role?: string; stage?: string }): ProgressEvent["stage"] => {
  if (event.role === "output" || event.stage === "compress") return "output";
  if (event.stage === "apply" || event.stage === "create") return "apply";
  return "input";
};

const toReactProgressEvent = (event: {
  details?: Record<string, unknown>;
  hasProgress?: boolean;
  id?: string;
  indeterminate?: boolean;
  label: string;
  percent?: number | null;
  role?: string;
  stage?: string;
  workflow?: string;
}): ProgressEvent => {
  const percent = normalizeProgressDisplayPercent(event.percent);
  const visualPercent = clampProgressPercent(event.percent);
  const hasProgress =
    event.hasProgress === false
      ? false
      : event.hasProgress === true || event.indeterminate === true || "percent" in event;
  return {
    details: {
      ...event.details,
      id: event.id,
      role: event.role,
      stage: event.stage,
      ...(visualPercent === null ? {} : { visualPercent }),
      workflow: event.workflow,
    },
    ...(event.hasProgress === false ? { hasProgress: false } : {}),
    ...(event.indeterminate === true ? { indeterminate: true } : {}),
    label: event.label,
    message: typeof percent === "number" ? `${event.label} ${percent}%` : event.label,
    ...(hasProgress ? { percent } : {}),
    stage: getReactProgressStage(event),
  };
};

const getWorkflowArchiveName = (
  source: CreateWorkflowSourceState | ApplyWorkflowInputState | ApplyWorkflowPatchState | undefined,
  originalName: string,
) => {
  if (source && "parentCompressions" in source) {
    const archivePath = [...(source.parentCompressions || [])]
      .sort((left, right) => left.depth - right.depth)
      .map((entry) => entry.fileName)
      .filter((fileName): fileName is string => !!fileName)
      .join(" > ");
    if (archivePath) return archivePath;
  }
  const fileName = source?.fileName || originalName;
  return originalName && fileName && originalName !== fileName ? originalName : "-";
};

const getSelectedResolvedInput = (source: ApplyWorkflowInputState | undefined | null) => {
  const resolvedInputs = source?.resolvedInputs || [];
  return resolvedInputs.find((entry) => entry.selected) || resolvedInputs[0] || null;
};

const getResolvedInputArchiveName = (
  resolved: NonNullable<ReturnType<typeof getSelectedResolvedInput>>,
  originalName: string,
) => {
  const archivePath = [...(resolved.parentCompressions || [])]
    .sort((left, right) => left.depth - right.depth)
    .map((entry) => entry.fileName)
    .filter((fileName): fileName is string => !!fileName)
    .join(" > ");
  if (archivePath) return archivePath;
  return originalName && resolved.fileName && originalName !== resolved.fileName ? originalName : "-";
};

const getStagedInputField = <TValue>(
  source: CreateWorkflowSourceState | ApplyWorkflowInputState,
  key: keyof CreateWorkflowSourceState,
): TValue | undefined => {
  return key in source ? (source[key as keyof typeof source] as TValue | undefined) : undefined;
};

const toStagedInputInfo = (
  source: CreateWorkflowSourceState | ApplyWorkflowInputState | undefined | null,
  originalName: string,
  checksums?: Record<string, string> | null,
) => {
  if (!source) return null;
  const resolved = "resolvedInputs" in source ? getSelectedResolvedInput(source) : null;
  const fileName = resolved?.fileName || source.fileName || originalName;
  return {
    archiveName: resolved
      ? getResolvedInputArchiveName(resolved, originalName)
      : getWorkflowArchiveName(source, originalName),
    chdCodecMode: resolved?.chdCodecMode ?? null,
    chdMode: resolved?.chdMode || getStagedInputField(source, "chdMode"),
    checksums: checksums || resolved?.checksums || getStagedInputField(source, "checksums"),
    checksumVariants: resolved?.checksumVariants || getStagedInputField(source, "checksumVariants"),
    decompressionTimeMs: resolved?.decompressionTimeMs ?? source.decompressionTimeMs,
    fileName,
    parentCompressions: resolved?.parentCompressions || getStagedInputField(source, "parentCompressions"),
    size: resolved?.size ?? source.size,
    sourceSize: resolved?.sourceSize ?? source.sourceSize,
    wasDecompressed: resolved?.wasDecompressed ?? source.wasDecompressed,
  };
};

const createWorkflowFormError = (code: string, message: string) => {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
};

export {
  createWorkflowFormError,
  getDefaultCreateOutputName,
  getReactBinarySourceFileName,
  toReactProgressEvent,
  toStagedInputInfo,
};
